/**
 * Per-clip work: demux, decode, composite and audio normalisation for a single input file.
 *
 * This is deliberately independent of *where* it runs. The coordinator runs it inline on machines
 * without spare threads, and the render workers run it on every other machine, so a single clip is
 * decoded and composited on one thread while the encoder keeps chewing on the previous clip.
 * Everything is pushed into a {@link ClipRenderSink}, which applies the backpressure that keeps
 * memory (and VRAM) bounded no matter how far ahead the renderer runs.
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input, VideoSampleSink } from 'mediabunny';
import type { AudioSample, InputVideoTrack, VideoSinkDecoderOptions } from 'mediabunny';
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AudioNormalizer } from '../lib/audio';
import {
	BlurredBackdrop,
	applyEffectOverlay,
	drawTitle,
	drawWithEffect,
	effectAt,
	type SegmentTransitions,
} from '../lib/effects';
import { FaceBlurrer, faceBlurPreset, loadFaceClassifier } from '../lib/face-blur';
import { GpsMiniMap, type GpsOverlayInput } from '../lib/gps-map';
import {
	ANALYSIS_LONG_EDGE,
	ClipMotionAnalyzer,
	applyStabilizerTransform,
	drawnContentSize,
	loadOpenCv,
	stabilizerPreset,
	type StabilizerPlan,
	type StabilizerPreset,
} from '../lib/stabilizer';
import type { FaceBlurSetting, FitMode, StabilizerSetting } from '../types';

export interface ClipRenderJob {
	file: File;
	width: number;
	height: number;
	fit: FitMode;
	/** Nominal duration of one output frame, in seconds. */
	frameInterval: number;
	/** Frames closer together than this are dropped to honour the output frame rate. */
	minFrameSpacing: number;
	/** Hard trim in seconds; 0 or Infinity means "use the whole clip". */
	maxClipSeconds: number;
	/** Seconds into the clip where rendering starts (a highlight segment); 0 for the beginning. */
	startSeconds: number;
	wantAudio: boolean;
	preferHardware: boolean;
	/** Strength of the software stabilizer, or `off` to skip the motion analysis pass. */
	stabilize: StabilizerSetting;
	/** How automatically detected faces are obscured, or `off` to skip face detection. */
	faceBlur: FaceBlurSetting;
	/** Fills the bars around a letterboxed clip with a blurred copy of itself instead of black. */
	blurredBackdrop: boolean;
	/** Cut effects at the start and end of the clip, or null for hard cuts. */
	transitions: SegmentTransitions | null;
	/** Seed for random-looking effects, so each clip glitches differently but reproducibly. */
	effectSeed: number;
	/** Pops the title in at the start of this clip (the first clip of a highlight). */
	titleIntro: boolean;
	/** Audio fade at both ends of the clip in seconds, which keeps fast cuts free of clicks. */
	audioFadeSeconds: number;
	/**
	 * Cuts audio exactly at the clip's length instead of letting the last packet run over. A
	 * highlight has many short segments, and those few milliseconds per cut would add up.
	 */
	exactLength: boolean;
	overlay: ImageBitmap | null;
	overlayX: number;
	overlayY: number;
	gps: GpsOverlayInput | null;
}

export interface ClipRenderSink {
	/** Takes ownership of `frame` - the sink must close (or transfer) it. */
	frame(frame: VideoFrame, timestamp: number, keyFrame: boolean): Promise<void> | void;
	/** Planar stereo PCM at 48 kHz: [left..., right...]. Takes ownership of `data`. */
	audio(data: Float32Array, frames: number, timestamp: number): Promise<void> | void;
	log(message: string, level: 'info' | 'warn' | 'error'): void;
}

export interface ClipRenderResult {
	/** End of the clip's video on the clip-relative timeline, in seconds. */
	videoEnd: number;
	/** End of the clip's audio on the clip-relative timeline, in seconds. */
	audioEnd: number;
	framesEmitted: number;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Splits a canonical (48 kHz stereo) sample into a transferable planar buffer, keeping only its
 * first `frames` frames.
 */
const toPlanarStereo = (sample: AudioSample, frames = sample.numberOfFrames): Float32Array => {
	const data = new Float32Array(frames * AUDIO_CHANNELS);
	for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
		const plane = data.subarray(channel * frames, (channel + 1) * frames);
		const sourceChannel = Math.min(channel, sample.numberOfChannels - 1);
		sample.copyTo(plane, { planeIndex: sourceChannel, format: 'f32-planar', frameCount: frames });
	}
	return data;
};

/** Linear fade-in/out over `fade` seconds at both ends of a `duration`-long clip, in place. */
const applyEdgeFade = (data: Float32Array, frames: number, startedAt: number, duration: number, fade: number) => {
	if (fade <= 0) return;
	const endsAt = startedAt + frames / AUDIO_SAMPLE_RATE;
	if (startedAt >= fade && endsAt <= duration - fade) return;
	for (let index = 0; index < frames; index++) {
		const time = startedAt + index / AUDIO_SAMPLE_RATE;
		const gain = Math.max(0, Math.min(1, time / fade, (duration - time) / fade));
		if (gain >= 1) continue;
		for (let channel = 0; channel < AUDIO_CHANNELS; channel++) data[channel * frames + index] *= gain;
	}
};

/**
 * First stabilizer pass: decodes the clip once at a small size and measures how the camera moved.
 * The result is a correction per frame; the encode pass then only has to look it up.
 *
 * The analysis is deliberately allowed to fail - a clip that cannot be tracked (or a browser
 * without WASM) is merged unstabilized rather than not at all.
 */
async function analyzeClipMotion(
	videoTrack: InputVideoTrack,
	from: number,
	to: number,
	preset: StabilizerPreset,
	isCanceled: () => boolean,
): Promise<StabilizerPlan | null> {
	const cv = await loadOpenCv();
	// Only the width is fixed: the sink derives the height, so the aspect ratio is never distorted.
	const displayWidth = await videoTrack.getDisplayWidth();
	const displayHeight = await videoTrack.getDisplayHeight();
	const longEdgeIsWidth = displayWidth >= displayHeight;
	const scale = Math.min(1, ANALYSIS_LONG_EDGE / Math.max(1, Math.max(displayWidth, displayHeight)));
	const sink = new CanvasSink(
		videoTrack,
		longEdgeIsWidth
			? { width: Math.max(16, Math.round(displayWidth * scale)) }
			: { height: Math.max(16, Math.round(displayHeight * scale)) },
	);

	let analyzer: ClipMotionAnalyzer | null = null;
	try {
		for await (const wrapped of sink.canvases(from, to)) {
			if (isCanceled()) return null;
			const canvas = wrapped.canvas;
			if (!(canvas instanceof OffscreenCanvas)) return null;
			const context = canvas.getContext('2d');
			if (!context) return null;

			analyzer ??= new ClipMotionAnalyzer(cv, canvas.width, canvas.height);
			const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
			analyzer.push(pixels.data, wrapped.timestamp);
		}

		return analyzer?.finish(preset) ?? null;
	} finally {
		analyzer?.dispose();
	}
}

/**
 * Decodes, composites and emits one clip. Video and audio are pulled concurrently so the two
 * decoders (which the browser runs on their own threads) both stay busy.
 */
export async function renderClip(
	job: ClipRenderJob,
	sink: ClipRenderSink,
	isCanceled: () => boolean,
): Promise<ClipRenderResult> {
	const canvas = new OffscreenCanvas(job.width, job.height);
	const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
	if (!ctx) throw new Error('Could not create a 2D rendering context.');
	const gpsMap = job.gps ? new GpsMiniMap(job.gps, job.width, job.height) : null;
	const backdrop = job.blurredBackdrop ? new BlurredBackdrop(job.width, job.height) : null;
	let faceBlurrer: FaceBlurrer | null = null;

	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(job.file) });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error('No video track');
		if (!(await videoTrack.canDecode())) throw new Error('Video codec cannot be decoded here');

		const firstTimestamp = await videoTrack.getFirstTimestamp();
		const trackDuration = await videoTrack.computeDuration();
		const available = Math.max(trackDuration - firstTimestamp, 0);
		const offset = Math.min(Math.max(0, job.startSeconds), available);
		const readStart = firstTimestamp + offset;
		const limit = job.maxClipSeconds > 0 ? job.maxClipSeconds : Infinity;
		const clipDuration = Math.min(available - offset, limit);
		if (clipDuration <= 0) throw new Error('Clip is empty');

		const readEnd = readStart + clipDuration;

		const preset = stabilizerPreset(job.stabilize);
		let stabilizer: StabilizerPlan | null = null;
		if (preset && !isCanceled()) {
			const startedAt = performance.now();
			try {
				stabilizer = await analyzeClipMotion(videoTrack, readStart, readEnd, preset, isCanceled);
				if (stabilizer) {
					const zoom = Math.round((stabilizer.zoom - 1) * 1000) / 10;
					sink.log(
						`Stabilizer: tracked ${stabilizer.trackedFrames}/${stabilizer.timestamps.length} frames in ` +
							`${((performance.now() - startedAt) / 1000).toFixed(1)}s, cropping ${zoom.toFixed(1)}%.`,
						'info',
					);
				} else if (!isCanceled()) {
					sink.log('Stabilizer found no trackable motion; this clip is merged as it is.', 'warn');
				}
			} catch (error) {
				sink.log(
					`Stabilizer unavailable (${errorMessage(error)}); this clip is merged unstabilized.`,
					'warn',
				);
			}
		}

		const blurPreset = faceBlurPreset(job.faceBlur);
		if (blurPreset && !isCanceled()) {
			try {
				const cv = await loadOpenCv();
				faceBlurrer = new FaceBlurrer(
					cv,
					await loadFaceClassifier(cv),
					blurPreset,
					job.width,
					job.height,
				);
			} catch (error) {
				// Never lose the clip over this, but say so loudly: the user asked for faces to be
				// hidden, and silently merging them in the clear would be the worst outcome here.
				sink.log(
					`Face detection unavailable (${errorMessage(error)}); faces in this clip are NOT obscured.`,
					'error',
				);
			}
		}

		// Audio is only committed once the clip's video is known to encode, so a clip that dies on
		// the very first frame never leaves orphaned audio behind in the timeline.
		let videoIsAlive: (alive: boolean) => void = () => undefined;
		const firstFrameEmitted = new Promise<boolean>((resolve) => {
			videoIsAlive = resolve;
		});

		let framesEmitted = 0;

		const decodeVideo = async (decoderOptions: VideoSinkDecoderOptions | undefined): Promise<number> => {
			const sink_ = new VideoSampleSink(videoTrack, decoderOptions);
			let lastRelative = -Infinity;
			let isFirstFrame = true;
			let clipEnd = 0;
			// A segment that starts between two frames first receives the frame covering its start.
			// The clip's clock begins at that frame, so frames stay evenly spaced from zero.
			let origin = readStart;

			for await (const sample of sink_.samples(readStart, readEnd)) {
				if (isCanceled()) {
					sample.close();
					break;
				}
				if (isFirstFrame && sample.timestamp < readStart) origin = sample.timestamp;
				const relative = sample.timestamp - origin;
				if (relative >= clipDuration - 1e-6) {
					sample.close();
					break;
				}
				if (!isFirstFrame && relative - lastRelative < job.minFrameSpacing) {
					sample.close();
					continue;
				}

				const timestamp = Math.max(0, relative);
				const effect = effectAt(job.transitions, timestamp, job.frameInterval, clipDuration, job.effectSeed);

				ctx.fillStyle = '#000000';
				ctx.fillRect(0, 0, job.width, job.height);
				// Called twice by a whip pan, which tiles the frame across the cut.
				drawWithEffect(ctx, job.width, job.height, effect, () => {
					backdrop?.draw(ctx, job.width, job.height, (backdropCtx) => {
						sample.drawWithFit(backdropCtx, { fit: 'cover' });
					});
					if (stabilizer) {
						// The correction is relative to the picture, not to the canvas, so a letterboxed
						// clip is not over-corrected by the width of its black bars.
						const content = drawnContentSize(
							sample.displayWidth,
							sample.displayHeight,
							job.width,
							job.height,
							job.fit,
						);
						ctx.save();
						applyStabilizerTransform(ctx, stabilizer, sample.timestamp, content, job);
						sample.drawWithFit(ctx, { fit: job.fit });
						ctx.restore();
					} else {
						sample.drawWithFit(ctx, { fit: job.fit });
					}
				});
				sample.close();
				// Faces are hidden before anything is drawn on top, so the title and the mini map
				// stay sharp and can never be smeared by a detection that overlaps them.
				faceBlurrer?.apply(canvas, ctx);
				applyEffectOverlay(ctx, canvas, job.width, job.height, effect);
				if (job.overlay) {
					drawTitle(ctx, job.overlay, job.overlayX, job.overlayY, job.titleIntro ? timestamp : null);
				}

				gpsMap?.draw(ctx, timestamp);
				// Snapshotting the canvas is what hands the pixels over to the encoder thread; from
				// here on the frame is just a handle, so it can safely cross a worker boundary.
				const frame = new VideoFrame(canvas, {
					timestamp: Math.round(timestamp * 1e6),
					duration: Math.round(job.frameInterval * 1e6),
					alpha: 'discard',
				});
				await sink.frame(frame, timestamp, isFirstFrame);

				lastRelative = relative;
				isFirstFrame = false;
				videoIsAlive(true);
				framesEmitted++;
				clipEnd = timestamp + job.frameInterval;
			}

			if (isFirstFrame) throw new Error('No decodable frames');
			return clipEnd;
		};

		const encodeVideo = async (): Promise<number> => {
			try {
				// A dedicated GPU decodes far faster than the software fallback, so ask for it
				// explicitly - but never let that hint cost us the clip.
				return await decodeVideo(
					job.preferHardware ? { hardwareAcceleration: 'prefer-hardware' } : undefined,
				);
			} catch (error) {
				if (!job.preferHardware || framesEmitted > 0 || isCanceled()) throw error;
				sink.log(
					`Hardware decoding failed (${errorMessage(error)}); retrying this clip in software.`,
					'warn',
				);
				return await decodeVideo(undefined);
			} finally {
				videoIsAlive(false);
			}
		};

		let audioEnd = 0;
		const encodeAudio = async (): Promise<void> => {
			if (!job.wantAudio) return;
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack || !(await audioTrack.canDecode())) return;
			if (!(await firstFrameEmitted)) return;

			const normalizer = new AudioNormalizer();
			const sink_ = new AudioSampleSink(audioTrack);
			for await (const sample of sink_.samples(readStart, readEnd)) {
				let normalized: AudioSample | null = null;
				try {
					if (isCanceled()) break;
					const relative = sample.timestamp - readStart;
					if (relative < -1e-6) continue;

					// The source channel layout and sample rate are irrelevant here: everything is
					// converted to one canonical format first.
					normalized = normalizer.convert(sample);
					if (normalized.numberOfFrames === 0) continue;

					const startedAt = Math.max(0, normalized.timestamp - readStart);
					if (job.exactLength && startedAt >= clipDuration - 1e-6) break;
					const frames = job.exactLength
						? Math.min(normalized.numberOfFrames, Math.ceil((clipDuration - startedAt) * AUDIO_SAMPLE_RATE))
						: normalized.numberOfFrames;
					if (frames <= 0) continue;
					const data = toPlanarStereo(normalized, frames);
					applyEdgeFade(data, frames, startedAt, clipDuration, job.audioFadeSeconds);
					await sink.audio(data, frames, startedAt);
					audioEnd = startedAt + frames / AUDIO_SAMPLE_RATE;
				} finally {
					if (normalized && normalized !== sample) normalized.close();
					sample.close();
				}
			}
		};

		const [videoResult, audioResult] = await Promise.allSettled([encodeVideo(), encodeAudio()]);
		if (audioResult.status === 'rejected') {
			sink.log(`Audio could not be used (${errorMessage(audioResult.reason)}); using silence.`, 'warn');
		}
		if (videoResult.status === 'rejected') throw videoResult.reason;

		return { videoEnd: videoResult.value, audioEnd, framesEmitted };
	} finally {
		faceBlurrer?.dispose();
		input.dispose();
	}
}
