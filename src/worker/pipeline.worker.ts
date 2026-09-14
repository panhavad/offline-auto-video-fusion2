/**
 * Merge coordinator: probing, encoding and muxing live here, and so does the fan-out that keeps the
 * machine busy. Clips are decoded and composited in several concurrent lanes that run ahead of the
 * encoder, while the encoder itself - the one stage that must stay strictly sequential - is kept
 * permanently fed instead of waiting for the next frame to be decoded.
 *
 * Decoding, compositing and encoding are all hardware accelerated on a machine with a real GPU, and
 * each of them runs on its own browser-managed thread; overlapping them is what turns a GPU that is
 * idle two thirds of the time into one that runs all three blocks at once.
 *
 * The look-ahead is bounded by a memory budget (see `../lib/hardware`), and the muxed result is
 * streamed straight to disk, so memory usage stays flat regardless of how long the merged video
 * becomes or how many lanes are in flight.
 */
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	CanvasSink,
	Input,
	Mp4OutputFormat,
	Output,
	QUALITY_HIGH,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	StreamTarget,
	VideoSample,
	VideoSampleSource,
	canEncodeVideo,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	type AudioCodec,
	type InputVideoTrack,
	type Quality,
	type StreamTargetChunk,
	type VideoCodec,
} from 'mediabunny';
import type {
	ClipOrientation,
	MergeItem,
	MergeRequest,
	MergeSettings,
	ProbeResult,
	WorkerInMessage,
	WorkerOutMessage,
} from '../types';
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AudioNormalizer } from '../lib/audio';
import { formatFrameRate, resolveFrameRate } from '../lib/framerate';
import { locationFromMetadata } from '../lib/gps';
import { describeHardware, describePlan, detectHardware, planPipeline, type PipelinePlan } from '../lib/hardware';
import { renderTitleOverlay } from '../lib/title-overlay';
import { renderClip, type ClipRenderJob, type ClipRenderResult, type ClipRenderSink } from './clip-renderer';
import {
	FALLBACK_SOURCE_HEIGHT,
	FALLBACK_SOURCE_WIDTH,
	evenEdge,
	formatSize,
	resolveFitMode,
	resolveOutputSize,
	type OutputSize,
} from '../lib/resolution';

const SILENCE_CHUNK_SECONDS = 0.5;
const PROGRESS_INTERVAL_MS = 200;
/** Scales tried in order when the encoder refuses the frame the first clip asks for. */
const ENCODE_SIZE_FALLBACKS = [1, 0.75, 0.5, 0.25];
const THUMBNAIL_MAX_WIDTH = 160;
const THUMBNAIL_MAX_HEIGHT = 90;
/** Skip the very first frame: openings are often black or a fade-in. */
const THUMBNAIL_OFFSET_SECONDS = 1;
const VIDEO_CODEC_CANDIDATES: VideoCodec[] = ['avc', 'hevc', 'av1', 'vp9'];
const AUDIO_CODEC_CANDIDATES: AudioCodec[] = ['aac', 'opus'];

let cancelRequested = false;
let merging = false;

const post = (message: WorkerOutMessage, transfer: Transferable[] = []) => {
	(self as unknown as { postMessage(m: WorkerOutMessage, t: Transferable[]): void }).postMessage(message, transfer);
};

const log = (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
	post({ type: 'log', level, message });
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

self.addEventListener('message', (event: MessageEvent<WorkerInMessage>) => {
	const data = event.data;
	if (data.type === 'probe') {
		void probeFile(data.id, data.file);
	} else if (data.type === 'merge') {
		if (merging) return;
		merging = true;
		cancelRequested = false;
		void runMerge(data.request).finally(() => {
			merging = false;
		});
	} else if (data.type === 'cancel') {
		cancelRequested = true;
		cancelAllLanes();
	}
});

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

const orientationOf = (width: number, height: number): ClipOrientation => {
	if (width > height) return 'landscape';
	if (height > width) return 'portrait';
	return 'square';
};

/**
 * Decodes one early frame and returns it as a small JPEG for the clip list. Rotation metadata is
 * applied by the sink, so portrait clips come out upright. A failure here is never fatal: the clip
 * is simply listed without a preview.
 */
async function makeThumbnail(
	videoTrack: InputVideoTrack,
	width: number,
	height: number,
	firstTimestamp: number,
	duration: number,
): Promise<Blob | null> {
	try {
		const aspect = width > 0 && height > 0 ? width / height : THUMBNAIL_MAX_WIDTH / THUMBNAIL_MAX_HEIGHT;
		const box = aspect >= THUMBNAIL_MAX_WIDTH / THUMBNAIL_MAX_HEIGHT
			? { width: THUMBNAIL_MAX_WIDTH }
			: { height: THUMBNAIL_MAX_HEIGHT };
		const sink = new CanvasSink(videoTrack, box);
		const offset = Math.min(THUMBNAIL_OFFSET_SECONDS, Math.max(0, duration) / 2);
		const wrapped =
			(await sink.getCanvas(firstTimestamp + offset)) ?? (await sink.getCanvas(firstTimestamp));
		if (!wrapped) return null;
		const canvas = wrapped.canvas;
		if (!(canvas instanceof OffscreenCanvas)) return null;
		return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
	} catch {
		return null;
	}
}

async function probeFile(id: string, file: File): Promise<void> {
	const empty: ProbeResult = {
		ok: false,
		width: 0,
		height: 0,
		rotation: 0,
		duration: 0,
		orientation: 'landscape',
		frameRate: null,
		hasAudio: false,
		codec: null,
		createdAt: null,
		location: null,
		thumbnail: null,
	};

	let input: Input | null = null;
	try {
		input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			post({ type: 'probed', id, result: { ...empty, error: 'No video track' } });
			return;
		}

		const [width, height, rotation, codec, decodable] = await Promise.all([
			videoTrack.getDisplayWidth(),
			videoTrack.getDisplayHeight(),
			videoTrack.getRotation(),
			videoTrack.getCodec(),
			videoTrack.canDecode(),
		]);

		if (!decodable) {
			post({
				type: 'probed',
				id,
				result: { ...empty, width, height, rotation, codec, error: `Codec not decodable (${codec ?? 'unknown'})` },
			});
			return;
		}

		const duration = await videoTrack.computeDuration();
		const firstTimestamp = await videoTrack.getFirstTimestamp();
		const audioTrack = await input.getPrimaryAudioTrack();
		let frameRate: number | null = null;
		try {
			const stats = await videoTrack.computePacketStats(60);
			frameRate = stats.averagePacketRate ?? null;
		} catch {
			frameRate = null;
		}

		let createdAt: number | null = null;
		let location = null;
		try {
			const tags = await input.getMetadataTags();
			if (tags.date instanceof Date && !Number.isNaN(tags.date.getTime())) {
				createdAt = tags.date.getTime();
			}
			location = locationFromMetadata(tags.raw);
		} catch {
			createdAt = null;
		}

		const trimmedDuration = Math.max(0, duration - firstTimestamp);
		const thumbnail = await makeThumbnail(videoTrack, width, height, firstTimestamp, trimmedDuration);

		post({
			type: 'probed',
			id,
			result: {
				ok: true,
				width,
				height,
				rotation,
				duration: trimmedDuration,
				orientation: orientationOf(width, height),
				frameRate,
				hasAudio: Boolean(audioTrack),
				codec,
				createdAt,
				location,
				thumbnail,
			},
		});
	} catch (error) {
		post({ type: 'probed', id, result: { ...empty, error: errorMessage(error) } });
	} finally {
		input?.dispose();
	}
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

const qualityFor = (preset: MergeSettings['quality']): Quality => {
	if (preset === 'high') return QUALITY_HIGH;
	if (preset === 'low') return QUALITY_LOW;
	return QUALITY_MEDIUM;
};

/**
 * Reads the frame the output should follow from the first clip in the list. Everything after it is
 * fitted into that frame, so the first clip is the one that never gets cropped or letterboxed.
 */
async function resolveDimensions(items: MergeItem[], settings: MergeSettings): Promise<OutputSize> {
	let sourceWidth = FALLBACK_SOURCE_WIDTH;
	let sourceHeight = FALLBACK_SOURCE_HEIGHT;

	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(items[0].file) });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (track) {
			sourceWidth = await track.getDisplayWidth();
			sourceHeight = await track.getDisplayHeight();
		}
	} catch {
		/* fall back to the defaults above */
	} finally {
		input.dispose();
	}

	return resolveOutputSize(settings.resolution, settings.aspectRatio, sourceWidth, sourceHeight);
}

/**
 * Finds a codec for the requested frame. Following the first clip means the frame can be larger
 * than the encoder supports (8K phone footage, for example), so the frame is progressively scaled
 * down instead of failing the whole merge.
 */
async function pickVideoCodec(
	requested: OutputSize,
	quality: Quality,
	preferHardware: boolean,
): Promise<{ size: OutputSize; codec: VideoCodec; hardware: 'prefer-hardware' | 'no-preference' }> {
	let size: OutputSize | null = null;
	let codec: VideoCodec | null = null;

	for (const scale of ENCODE_SIZE_FALLBACKS) {
		const candidate =
			scale === 1
				? requested
				: { width: evenEdge(requested.width * scale), height: evenEdge(requested.height * scale) };
		codec = await getFirstEncodableVideoCodec(VIDEO_CODEC_CANDIDATES, {
			width: candidate.width,
			height: candidate.height,
			quality,
		});
		if (codec) {
			size = candidate;
			break;
		}
	}

	if (!codec || !size) {
		throw new Error('This browser cannot encode video with WebCodecs. Try a recent Chrome or Edge build.');
	}
	if (size.width !== requested.width || size.height !== requested.height) {
		log(
			`The encoder cannot handle ${formatSize(requested)}; the output was scaled down to ${formatSize(size)}.`,
			'warn',
		);
	}

	if (!preferHardware) return { size, codec, hardware: 'no-preference' };

	const hardwareOk = await canEncodeVideo(codec, {
		width: size.width,
		height: size.height,
		quality,
		hardwareAcceleration: 'prefer-hardware',
	}).catch(() => false);

	return { size, codec, hardware: hardwareOk ? 'prefer-hardware' : 'no-preference' };
}

// ---------------------------------------------------------------------------
// Render lanes - the concurrent decode + composite stage
// ---------------------------------------------------------------------------

type ClipEvent =
	| { kind: 'frame'; frame: VideoFrame; timestamp: number; keyFrame: boolean }
	| { kind: 'audio'; data: Float32Array; frames: number; timestamp: number }
	| { kind: 'log'; message: string; level: 'info' | 'warn' | 'error' }
	| { kind: 'done'; result: ClipRenderResult }
	| { kind: 'failed'; error: string };

/**
 * A lane renders one clip at a time and hands the finished frames to the encoder. Several lanes run
 * at once, each limited by the credits it was given, so the look-ahead never outgrows its budget.
 *
 * Lanes deliberately run on *this* thread rather than in separate workers. A composited frame lives
 * in GPU memory; moving it to another worker forces a full read-back per frame, which measured
 * about four times slower than doing everything here. The expensive stages - demuxing, decoding and
 * encoding - already run on their own threads inside the browser, so overlapping several clips from
 * one JS thread is what actually keeps the GPU's decoder and encoder blocks busy at the same time.
 */
interface RenderLane {
	start(job: ClipRenderJob, frameCredits: number, audioCredits: number): void;
	next(): Promise<ClipEvent>;
	/** Returns consumed capacity so the lane may produce more. */
	ack(frames: number, audio: number): void;
	/** Stops the current clip and unblocks a pending {@link next} call. */
	cancel(): void;
	dispose(): void;
}

/** Every live lane, so a cancel request also reaches lanes parked on backpressure. */
const activeLanes = new Set<RenderLane>();

const cancelAllLanes = () => {
	for (const lane of activeLanes) {
		try {
			lane.cancel();
		} catch {
			/* a lane that already finished needs no cancelling */
		}
	}
};

const releaseEvent = (event: ClipEvent) => {
	if (event.kind === 'frame') event.frame.close();
};

/** Single-consumer event queue between a lane and the encoder. */
const createEventChannel = () => {
	const queue: ClipEvent[] = [];
	let waiter: ((event: ClipEvent) => void) | null = null;

	return {
		push(event: ClipEvent) {
			if (waiter) {
				const resolve = waiter;
				waiter = null;
				resolve(event);
				return;
			}
			queue.push(event);
		},
		next(): Promise<ClipEvent> {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			return new Promise<ClipEvent>((resolve) => {
				waiter = resolve;
			});
		},
		drain() {
			for (const event of queue) releaseEvent(event);
			queue.length = 0;
			waiter = null;
		},
	};
};

const createRenderLane = (): RenderLane => {
	const channel = createEventChannel();
	let frameCredits = 0;
	let audioCredits = 0;
	let creditWaiters: (() => void)[] = [];

	const wake = () => {
		const waiting = creditWaiters;
		creditWaiters = [];
		for (const resolve of waiting) resolve();
	};

	const awaitCredit = async (kind: 'frame' | 'audio'): Promise<void> => {
		while (!cancelRequested && (kind === 'frame' ? frameCredits : audioCredits) <= 0) {
			await new Promise<void>((resolve) => creditWaiters.push(resolve));
		}
	};

	const sink: ClipRenderSink = {
		async frame(frame, timestamp, keyFrame) {
			await awaitCredit('frame');
			if (cancelRequested) {
				frame.close();
				return;
			}
			frameCredits--;
			channel.push({ kind: 'frame', frame, timestamp, keyFrame });
		},
		async audio(data, frames, timestamp) {
			await awaitCredit('audio');
			if (cancelRequested) return;
			audioCredits--;
			channel.push({ kind: 'audio', data, frames, timestamp });
		},
		log(message, level) {
			channel.push({ kind: 'log', message, level });
		},
	};

	const lane: RenderLane = {
		start(job, frames, audio) {
			frameCredits = frames;
			audioCredits = audio;
			void renderClip(job, sink, () => cancelRequested)
				.then((result) => channel.push({ kind: 'done', result }))
				.catch((error) => channel.push({ kind: 'failed', error: errorMessage(error) }))
				.finally(() => job.overlay?.close());
		},
		next: () => channel.next(),
		ack(frames, audio) {
			frameCredits += frames;
			audioCredits += audio;
			wake();
		},
		cancel() {
			// Releases the render loop, which then unwinds and reports back on its own.
			wake();
			channel.push({ kind: 'failed', error: 'Canceled' });
		},
		dispose() {
			wake();
			channel.drain();
			activeLanes.delete(lane);
		},
	};

	activeLanes.add(lane);
	return lane;
};

async function runMerge(request: MergeRequest): Promise<void> {
	const { items, settings, gpsTrack } = request;
	const startedAt = performance.now();

	if (items.length === 0) {
		post({ type: 'error', message: 'No videos selected.' });
		return;
	}

	let output: Output | null = null;
	let bytesWritten = 0;

	try {
		const requestedSize = await resolveDimensions(items, settings);
		const quality = qualityFor(settings.quality);
		const {
			size: { width, height },
			codec: videoCodec,
			hardware,
		} = await pickVideoCodec(requestedSize, quality, settings.preferHardware);

		const overlay = renderTitleOverlay(settings, width, height);
		const fit = resolveFitMode(settings.resolution, settings.aspectRatio, settings.fit);
		const frameRate = resolveFrameRate(settings.frameRate, items.map((item) => item.sourceFrameRate));

		// How much of the machine this merge is allowed to use. Decoding and compositing scale across
		// threads, the encoder does not - so the plan decides how far the pool may run ahead.
		const profile = await detectHardware();
		const plan: PipelinePlan = planPipeline(profile, {
			clips: items.length,
			width,
			height,
			mode: settings.accelerationMode,
			preferHardware: settings.preferHardware,
		});

		let audioCodec: AudioCodec | null = null;
		if (settings.includeAudio) {
			audioCodec = await getFirstEncodableAudioCodec(AUDIO_CODEC_CANDIDATES, {
				numberOfChannels: AUDIO_CHANNELS,
				sampleRate: AUDIO_SAMPLE_RATE,
			});
			if (!audioCodec) log('No audio encoder available - writing a video-only file.', 'warn');
		}

		const target =
			request.target.kind === 'file'
				? new StreamTarget(
						(await request.target.handle.createWritable()) as unknown as WritableStream<StreamTargetChunk>,
						{ chunked: true, chunkSize: 8 * 1024 * 1024 },
					)
				: new BufferTarget();

		target.on('write', ({ end }) => {
			if (end > bytesWritten) bytesWritten = end;
		});

		output = new Output({ format: new Mp4OutputFormat(), target });

		const videoSource = new VideoSampleSource({
			codec: videoCodec,
			quality,
			keyFrameInterval: 2,
			hardwareAcceleration: hardware,
			sizeChangeBehavior: 'passThrough',
		});
		output.addVideoTrack(videoSource);

		// Every sample is already normalized to 48 kHz stereo before it gets here, so no further
		// transform is needed (and none is wanted - it would just add another resampling stage).
		const audioSource = audioCodec
			? new AudioSampleSource({ codec: audioCodec, quality: QUALITY_MEDIUM })
			: null;
		if (audioSource) output.addAudioTrack(audioSource);

		await output.start();
		post({ type: 'started', videoCodec, audioCodec, width, height, frameRate });
		log(
			`Encoding ${formatSize({ width, height })} at up to ${formatFrameRate(frameRate)} using ${videoCodec.toUpperCase()}` +
				`${hardware === 'prefer-hardware' ? ' (hardware accelerated)' : ''}` +
				`${audioCodec ? ` + ${audioCodec.toUpperCase()} audio` : ' (no audio)'}.`,
		);
		log(`Machine: ${describeHardware(profile)}.`);
		const forcedFrame = [
			settings.aspectRatio === 'auto' ? null : `${settings.aspectRatio} aspect ratio`,
			settings.resolution === 'auto' ? null : `${settings.resolution}p`,
		].filter(Boolean);
		log(
			forcedFrame.length === 0
				? `Frame follows the first clip: ${formatSize({ width, height })}.`
				: `Frame forced to ${forcedFrame.join(' at ')} (${formatSize({ width, height })}); clips that do not fit are cropped to fill.`,
		);
		if (settings.frameRate === 'auto') {
			const detected = items.some((item) => typeof item.sourceFrameRate === 'number' && item.sourceFrameRate > 0);
			log(
				detected
					? `Frame rate follows the fastest source clip: ${formatFrameRate(frameRate)}.`
					: `Source frame rate could not be detected; using the ${formatFrameRate(frameRate)} upper limit.`,
				detected ? 'info' : 'warn',
			);
		}

		const totalSeconds = items.reduce((sum, item) => sum + item.plannedSeconds, 0);
		const frameInterval = 1 / frameRate;
		// In auto mode the cap comes from the footage itself, so the usual hairline tolerance is
		// widened: timestamp jitter in a nominally constant-rate source must not cost frames.
		const minFrameSpacing = settings.frameRate === 'auto' ? frameInterval * 0.9 : frameInterval - 1e-4;
		if (gpsTrack) {
			const firstGpsTime = gpsTrack.points[0].timestamp;
			const lastGpsTime = gpsTrack.points[gpsTrack.points.length - 1].timestamp;
			if (firstGpsTime === null) {
				log(`GPS mini map: "${gpsTrack.name}" has no timestamps, so its route follows each clip's progress.`, 'warn');
			} else {
				log(`GPS mini map: "${gpsTrack.name}" is synchronized from its timestamps.`);
				for (const item of items) {
					if (item.createdAt !== null) {
						const clipEnd = item.createdAt + item.plannedSeconds * 1000;
						if (clipEnd < firstGpsTime || item.createdAt > lastGpsTime!) {
							log(`"${item.name}" is outside the GPS track's time range; its mini map will be hidden.`, 'warn');
						}
					} else if (item.location) {
						log(`"${item.name}" has no creation time; its embedded GPS location anchors the mini map.`, 'warn');
					} else {
						log(`"${item.name}" has no usable time or GPS metadata; the mini map starts at the beginning of the track.`, 'warn');
					}
				}
			}
		}

		let timelineCursor = 0;
		let audioCursor = 0;
		let framesEncoded = 0;
		let completedSeconds = 0;
		let lastProgressAt = 0;

		const reportProgress = (index: number, name: string, clipSeconds: number, force = false) => {
			const now = performance.now();
			if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
			lastProgressAt = now;
			const elapsedMs = now - startedAt;
			const processedSeconds = Math.min(totalSeconds, completedSeconds + clipSeconds);
			const ratio = totalSeconds > 0 ? processedSeconds / totalSeconds : 0;
			post({
				type: 'progress',
				progress: {
					processedSeconds,
					totalSeconds,
					currentIndex: index,
					totalItems: items.length,
					currentName: name,
					framesEncoded,
					fps: elapsedMs > 0 ? (framesEncoded / elapsedMs) * 1000 : 0,
					bytesWritten,
					elapsedMs,
					etaMs: ratio > 0.001 ? (elapsedMs / ratio) * (1 - ratio) : null,
				},
			});
		};

		// If audio ever fails unexpectedly we drop the audio track rather than lose the video.
		let audioBroken = false;

		const disableAudio = (reason: string) => {
			if (audioBroken) return;
			audioBroken = true;
			log(`Audio disabled for the rest of the merge: ${reason}`, 'warn');
		};

		const addSilence = async (from: number, duration: number): Promise<number> => {
			if (!audioSource || audioBroken || duration <= 0.001) return from;
			let cursor = from;
			const end = from + duration;
			try {
				while (end - cursor > 0.001 && !cancelRequested) {
					const chunkSeconds = Math.min(SILENCE_CHUNK_SECONDS, end - cursor);
					const frames = Math.max(1, Math.round(chunkSeconds * AUDIO_SAMPLE_RATE));
					const sample = AudioNormalizer.silence(cursor, frames);
					try {
						await audioSource.add(sample);
					} finally {
						sample.close();
					}
					cursor += frames / AUDIO_SAMPLE_RATE;
				}
			} catch (error) {
				disableAudio(errorMessage(error));
			}
			return cursor;
		};

		// -------------------------------------------------------------------
		// Start the decode/composite lanes
		// -------------------------------------------------------------------

		const lanes: RenderLane[] = Array.from({ length: Math.max(1, plan.renderThreads) }, createRenderLane);
		log(`Pipeline: ${describePlan({ ...plan, renderThreads: lanes.length })}.`);

		const makeJob = async (item: MergeItem): Promise<ClipRenderJob> => ({
			file: item.file,
			width,
			height,
			fit,
			frameInterval,
			minFrameSpacing,
			maxClipSeconds: settings.maxClipSeconds,
			wantAudio: Boolean(audioSource) && !audioBroken,
			preferHardware: plan.preferHardware,
			stabilize: settings.stabilize,
			gps: gpsTrack
				? {
						points: gpsTrack.points,
						clipCreatedAt: item.createdAt,
						clipLocation: item.location,
						clipDuration: item.plannedSeconds,
						position: settings.gpsMapPosition,
						size: settings.gpsMapSize,
						background: settings.gpsMapBackground,
						rotation: settings.gpsMapRotation,
						showSpeed: settings.gpsShowSpeed,
						showAltitude: settings.gpsShowAltitude,
						showDistance: settings.gpsShowDistance,
						showCoordinates: settings.gpsShowCoordinates,
						showDateTime: settings.gpsShowDateTime,
					}
				: null,
			// Every lane composites on its own canvas, so each needs its own copy of the overlay.
			overlay: overlay ? await createImageBitmap(overlay.canvas) : null,
			overlayX: overlay?.x ?? 0,
			overlayY: overlay?.y ?? 0,
		});

		const assignments = new Map<number, RenderLane>();
		let nextJobIndex = 0;

		/** Hands the next unrendered clip to an idle lane, which is what creates the look-ahead. */
		const assignNext = async (lane: RenderLane): Promise<void> => {
			if (cancelRequested || nextJobIndex >= items.length) return;
			const index = nextJobIndex++;
			assignments.set(index, lane);
			lane.start(await makeJob(items[index]), plan.frameQueueDepth, plan.audioQueueDepth);
		};

		for (const lane of lanes) {
			if (cancelRequested) break;
			await assignNext(lane);
		}

		try {
			for (const [index, item] of items.entries()) {
				if (cancelRequested) break;
				reportProgress(index, item.name, 0, true);

				const lane = assignments.get(index);
				assignments.delete(index);
				if (!lane) break;

				const clipStart = timelineCursor;
				let videoEnd = clipStart;
				let clipError: string | null = null;
				let clipResult: ClipRenderResult | null = null;

				// Consume this clip's stream in order; the other lanes keep rendering meanwhile.
				while (!clipResult && !clipError) {
					const event = await lane.next();

					if (cancelRequested) {
						releaseEvent(event);
						break;
					}

					if (event.kind === 'frame') {
						const timestamp = clipStart + event.timestamp;
						const sample = new VideoSample(event.frame, { timestamp, duration: frameInterval });
						try {
							await videoSource.add(sample, event.keyFrame ? { keyFrame: true } : undefined);
						} finally {
							sample.close();
							lane.ack(1, 0);
						}
						framesEncoded++;
						videoEnd = timestamp + frameInterval;
						reportProgress(index, item.name, event.timestamp);
					} else if (event.kind === 'audio') {
						const timestamp = clipStart + event.timestamp;
						if (audioSource && !audioBroken && timestamp >= audioCursor - 1e-3) {
							try {
								if (timestamp > audioCursor + 1e-3) {
									audioCursor = await addSilence(audioCursor, timestamp - audioCursor);
								}
								if (!audioBroken) {
									const sample = new AudioSample({
										data: event.data,
										format: 'f32-planar',
										numberOfChannels: AUDIO_CHANNELS,
										sampleRate: AUDIO_SAMPLE_RATE,
										timestamp: Math.max(timestamp, audioCursor),
									});
									try {
										await audioSource.add(sample);
										audioCursor = sample.timestamp + sample.duration;
									} finally {
										sample.close();
									}
								}
							} catch (error) {
								disableAudio(errorMessage(error));
							}
						}
						lane.ack(0, 1);
					} else if (event.kind === 'log') {
						log(`"${item.name}": ${event.message}`, event.level);
					} else if (event.kind === 'done') {
						clipResult = event.result;
					} else {
						clipError = event.error;
					}
				}

				if (cancelRequested) break;

				if (clipResult) {
					const clipEnd = Math.max(videoEnd, audioCursor);
					if (audioSource && !audioBroken && audioCursor < clipEnd - 1e-3) {
						audioCursor = await addSilence(audioCursor, clipEnd - audioCursor);
					}

					timelineCursor = clipEnd;
					completedSeconds += Math.min(item.plannedSeconds, clipEnd - clipStart);
					post({ type: 'item-done', id: item.id, encodedSeconds: clipEnd - clipStart });
					reportProgress(index + 1, item.name, 0, true);
				} else {
					// Keep the audio and video timelines aligned even when a clip drops out, and keep
					// whatever part of it did encode before the failure.
					timelineCursor = Math.max(timelineCursor, videoEnd, audioCursor);
					completedSeconds += item.plannedSeconds;
					post({ type: 'item-failed', id: item.id, error: clipError ?? 'Clip could not be rendered' });
					log(`Skipped "${item.name}": ${clipError ?? 'unknown error'}`, 'warn');
				}

				await assignNext(lane);
			}
		} finally {
			for (const lane of lanes) lane.dispose();
			lanes.length = 0;
		}

		if (cancelRequested) {
			await output.cancel();
			post({ type: 'canceled' });
			return;
		}

		if (timelineCursor <= 0) {
			await output.cancel();
			post({ type: 'error', message: 'Nothing could be encoded - every clip failed.' });
			return;
		}

		await output.finalize();

		const buffer = output.target instanceof BufferTarget ? output.target.buffer : null;
		post(
			{
				type: 'done',
				buffer,
				bytes: buffer ? buffer.byteLength : bytesWritten,
				durationSeconds: timelineCursor,
				elapsedMs: performance.now() - startedAt,
			},
			buffer ? [buffer] : [],
		);
	} catch (error) {
		if (output && output.state !== 'finalized' && output.state !== 'canceled') {
			await output.cancel().catch(() => undefined);
		}
		post({ type: 'error', message: errorMessage(error) });
	}
}
