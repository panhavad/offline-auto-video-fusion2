/**
 * All heavy lifting happens in this worker: probing, decoding, compositing and encoding.
 * Decoding and encoding go through WebCodecs (hardware accelerated where the platform allows it),
 * compositing runs on a GPU-backed OffscreenCanvas, and the muxed result is streamed straight to
 * disk so that memory usage stays flat regardless of how long the merged video becomes.
 */
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	Input,
	Mp4OutputFormat,
	Output,
	QUALITY_HIGH,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	StreamTarget,
	VideoSampleSink,
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

const SILENCE_CHUNK_SECONDS = 0.5;
const PROGRESS_INTERVAL_MS = 200;
const AUTO_MAX_LONG_EDGE = 1920;
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
		try {
			const tags = await input.getMetadataTags();
			if (tags.date instanceof Date && !Number.isNaN(tags.date.getTime())) {
				createdAt = tags.date.getTime();
			}
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

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

async function resolveDimensions(
	items: MergeItem[],
	settings: MergeSettings,
): Promise<{ width: number; height: number }> {
	let portrait = settings.orientation === 'portrait';
	let sourceWidth = 1920;
	let sourceHeight = 1080;

	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(items[0].file) });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (track) {
			sourceWidth = await track.getDisplayWidth();
			sourceHeight = await track.getDisplayHeight();
			if (settings.orientation === 'any') {
				portrait = sourceHeight > sourceWidth;
			}
		}
	} catch {
		/* fall back to the defaults above */
	} finally {
		input.dispose();
	}

	if (settings.resolution !== 'auto') {
		const shortEdge = Number(settings.resolution);
		const longEdge = even((shortEdge * 16) / 9);
		return portrait
			? { width: even(shortEdge), height: longEdge }
			: { width: longEdge, height: even(shortEdge) };
	}

	const longEdge = Math.max(sourceWidth, sourceHeight);
	const scale = longEdge > AUTO_MAX_LONG_EDGE ? AUTO_MAX_LONG_EDGE / longEdge : 1;
	return { width: even(sourceWidth * scale), height: even(sourceHeight * scale) };
}

interface TitleOverlay {
	canvas: OffscreenCanvas;
	x: number;
	y: number;
}

function renderTitle(settings: MergeSettings, width: number, height: number): TitleOverlay | null {
	const text = settings.title.trim();
	if (!text) return null;

	const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return null;

	const fontSize = Math.max(10, Math.round((height * settings.titleScale) / 100));
	const font = `600 ${fontSize}px "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
	const lineHeight = Math.round(fontSize * 1.25);
	const blur = settings.titleShadow ? Math.round(fontSize * 0.3) : 0;
	const pad = blur * 2 + 4;

	const measurer = new OffscreenCanvas(8, 8).getContext('2d');
	if (!measurer) return null;
	measurer.font = font;
	const textWidth = Math.ceil(Math.max(...lines.map((line) => measurer.measureText(line).width)));

	const canvas = new OffscreenCanvas(
		Math.max(1, textWidth + pad * 2),
		Math.max(1, lineHeight * lines.length + pad * 2),
	);
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;

	ctx.font = font;
	ctx.textBaseline = 'top';
	ctx.textAlign = 'left';
	if (blur > 0) {
		ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
		ctx.shadowBlur = blur;
		ctx.shadowOffsetY = Math.round(fontSize * 0.05);
	}
	ctx.fillStyle = settings.titleColor;
	lines.forEach((line, index) => {
		ctx.fillText(line, pad, pad + index * lineHeight);
	});

	const margin = Math.round(Math.min(width, height) * 0.04);
	const [vertical, horizontal] = settings.titlePosition.split('-');

	let x = margin - pad;
	if (horizontal === 'center') x = Math.round((width - canvas.width) / 2);
	else if (horizontal === 'right') x = width - canvas.width - margin + pad;

	let y = margin - pad;
	if (vertical === 'middle') y = Math.round((height - canvas.height) / 2);
	else if (vertical === 'bottom') y = height - canvas.height - margin + pad;

	return { canvas, x, y };
}

async function pickVideoCodec(
	width: number,
	height: number,
	quality: Quality,
	preferHardware: boolean,
): Promise<{ codec: VideoCodec; hardware: 'prefer-hardware' | 'no-preference' }> {
	const codec = await getFirstEncodableVideoCodec(VIDEO_CODEC_CANDIDATES, { width, height, quality });
	if (!codec) {
		throw new Error('This browser cannot encode video with WebCodecs. Try a recent Chrome or Edge build.');
	}
	if (!preferHardware) return { codec, hardware: 'no-preference' };

	const hardwareOk = await canEncodeVideo(codec, {
		width,
		height,
		quality,
		hardwareAcceleration: 'prefer-hardware',
	}).catch(() => false);

	return { codec, hardware: hardwareOk ? 'prefer-hardware' : 'no-preference' };
}

async function runMerge(request: MergeRequest): Promise<void> {
	const { items, settings } = request;
	const startedAt = performance.now();

	if (items.length === 0) {
		post({ type: 'error', message: 'No videos selected.' });
		return;
	}

	let output: Output | null = null;
	let bytesWritten = 0;

	try {
		const { width, height } = await resolveDimensions(items, settings);
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
		if (!ctx) throw new Error('Could not create a 2D rendering context.');

		const overlay = renderTitle(settings, width, height);
		const quality = qualityFor(settings.quality);
		const frameRate = resolveFrameRate(settings.frameRate, items.map((item) => item.sourceFrameRate));
		const { codec: videoCodec, hardware } = await pickVideoCodec(width, height, quality, settings.preferHardware);

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

		const videoSource = new CanvasSource(canvas, {
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
			`Encoding ${width}x${height} at up to ${formatFrameRate(frameRate)} using ${videoCodec.toUpperCase()}` +
				`${hardware === 'prefer-hardware' ? ' (hardware accelerated)' : ''}` +
				`${audioCodec ? ` + ${audioCodec.toUpperCase()} audio` : ' (no audio)'}.`,
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

		const normalizer = new AudioNormalizer();
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

		for (const [index, item] of items.entries()) {
			if (cancelRequested) break;
			reportProgress(index, item.name, 0, true);

			let input: Input | null = null;
			try {
				input = new Input({ formats: ALL_FORMATS, source: new BlobSource(item.file) });
				const clipInput = input;
				const videoTrack = await clipInput.getPrimaryVideoTrack();
				if (!videoTrack) throw new Error('No video track');
				if (!(await videoTrack.canDecode())) throw new Error('Video codec cannot be decoded here');

				const firstTimestamp = await videoTrack.getFirstTimestamp();
				const trackDuration = await videoTrack.computeDuration();
				const limit = settings.maxClipSeconds > 0 ? settings.maxClipSeconds : Infinity;
				const clipDuration = Math.min(Math.max(trackDuration - firstTimestamp, 0), limit);
				if (clipDuration <= 0) throw new Error('Clip is empty');

				const clipStart = timelineCursor;
				const readEnd = firstTimestamp + clipDuration;

				// Audio is only committed once the clip's video is known to encode, so a clip that
				// dies on the very first frame never leaves orphaned audio behind in the timeline.
				let videoIsAlive: (alive: boolean) => void = () => undefined;
				const firstFrameEncoded = new Promise<boolean>((resolve) => {
					videoIsAlive = resolve;
				});

				const encodeVideo = async (): Promise<number> => {
					const sink = new VideoSampleSink(videoTrack);
					let lastRelative = -Infinity;
					let isFirstFrame = true;
					let clipEnd = clipStart;

					try {
						for await (const sample of sink.samples(firstTimestamp, readEnd)) {
							if (cancelRequested) {
								sample.close();
								break;
							}
							const relative = sample.timestamp - firstTimestamp;
							if (!isFirstFrame && relative - lastRelative < minFrameSpacing) {
								sample.close();
								continue;
							}

							ctx.fillStyle = '#000000';
							ctx.fillRect(0, 0, width, height);
							sample.drawWithFit(ctx, { fit: settings.fit });
							sample.close();
							if (overlay) ctx.drawImage(overlay.canvas, overlay.x, overlay.y);

							const timestamp = clipStart + Math.max(0, relative);
							await videoSource.add(timestamp, frameInterval, isFirstFrame ? { keyFrame: true } : undefined);

							lastRelative = relative;
							isFirstFrame = false;
							videoIsAlive(true);
							framesEncoded++;
							clipEnd = timestamp + frameInterval;
							reportProgress(index, item.name, Math.max(0, relative));
						}
					} finally {
						videoIsAlive(false);
					}

					if (isFirstFrame) throw new Error('No decodable frames');
					return clipEnd;
				};

				const encodeAudio = async (): Promise<void> => {
					if (!audioSource || audioBroken) return;
					const audioTrack = await clipInput.getPrimaryAudioTrack();
					if (!audioTrack || !(await audioTrack.canDecode())) return;
					if (!(await firstFrameEncoded)) return;

					normalizer.reset();

					// A broken audio track must never cost us the clip's video: fall back to silence.
					try {
						const sink = new AudioSampleSink(audioTrack);
						for await (const sample of sink.samples(firstTimestamp, readEnd)) {
							let normalized: AudioSample | null = null;
							try {
								if (cancelRequested || audioBroken) break;
								const relative = sample.timestamp - firstTimestamp;
								const timestamp = clipStart + relative;
								if (relative < -1e-6 || timestamp < audioCursor - 1e-3) continue;

								// The source channel layout and sample rate are irrelevant here:
								// everything is converted to one canonical format first.
								normalized = normalizer.convert(sample);
								if (normalized.numberOfFrames === 0) continue;

								if (timestamp > audioCursor + 1e-3) {
									audioCursor = await addSilence(audioCursor, timestamp - audioCursor);
									if (audioBroken) break;
								}
								normalized.setTimestamp(Math.max(timestamp, audioCursor));
								await audioSource.add(normalized);
								audioCursor = normalized.timestamp + normalized.duration;
							} finally {
								if (normalized && normalized !== sample) normalized.close();
								sample.close();
							}
						}
					} catch (error) {
						log(`Audio of "${item.name}" could not be used (${errorMessage(error)}); using silence.`, 'warn');
					}
				};

				const [videoResult, audioResult] = await Promise.allSettled([encodeVideo(), encodeAudio()]);
				if (audioResult.status === 'rejected') {
					log(`Audio of "${item.name}" failed: ${errorMessage(audioResult.reason)}`, 'warn');
				}
				if (videoResult.status === 'rejected') throw videoResult.reason;

				const videoEnd = videoResult.value;
				const clipEnd = Math.max(videoEnd, audioCursor);
				if (audioSource && audioCursor < clipEnd - 1e-3) {
					audioCursor = await addSilence(audioCursor, clipEnd - audioCursor);
				}

				timelineCursor = clipEnd;
				completedSeconds += Math.min(item.plannedSeconds, clipEnd - clipStart);
				post({ type: 'item-done', id: item.id, encodedSeconds: clipEnd - clipStart });
				reportProgress(index + 1, item.name, 0, true);
			} catch (error) {
				const message = errorMessage(error);
				// Keep the audio timeline and the video timeline aligned even when a clip drops out.
				timelineCursor = Math.max(timelineCursor, audioCursor);
				completedSeconds += item.plannedSeconds;
				post({ type: 'item-failed', id: item.id, error: message });
				log(`Skipped "${item.name}": ${message}`, 'warn');
			} finally {
				input?.dispose();
			}
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
