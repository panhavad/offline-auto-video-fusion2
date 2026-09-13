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
	ANALYSIS_LONG_EDGE,
	ClipMotionAnalyzer,
	applyStabilizerTransform,
	drawnContentSize,
	loadOpenCv,
	stabilizerPreset,
	type StabilizerPlan,
	type StabilizerPreset,
} from '../lib/stabilizer';
import type { FitMode, GeoPoint, GpsMapPosition, GpsPoint, StabilizerSetting } from '../types';

export interface GpsOverlayInput {
	points: GpsPoint[];
	clipCreatedAt: number | null;
	clipLocation: GeoPoint | null;
	clipDuration: number;
	position: GpsMapPosition;
}

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
	wantAudio: boolean;
	preferHardware: boolean;
	/** Strength of the software stabilizer, or `off` to skip the motion analysis pass. */
	stabilize: StabilizerSetting;
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

const distanceSquared = (a: GeoPoint, b: GeoPoint): number => {
	const latitudeScale = Math.cos(((a.latitude + b.latitude) * Math.PI) / 360);
	const x = (a.longitude - b.longitude) * latitudeScale;
	const y = a.latitude - b.latitude;
	return x * x + y * y;
};

const distanceMetres = (a: GeoPoint, b: GeoPoint): number => {
	const latitudeScale = Math.cos(((a.latitude + b.latitude) * Math.PI) / 360);
	const x = (b.longitude - a.longitude) * latitudeScale;
	const y = b.latitude - a.latitude;
	return Math.hypot(x, y) * 111_320;
};

interface PositionedGpsPoint extends GpsPoint {
	x: number;
	y: number;
}

class GpsMiniMap {
	private readonly points: PositionedGpsPoint[];
	private readonly startTime: number | null;
	private readonly width: number;
	private readonly height: number;
	private readonly x: number;
	private readonly y: number;
	private readonly padding: number;
	private readonly base: OffscreenCanvas;

	constructor(
		private readonly input: GpsOverlayInput,
		frameWidth: number,
		frameHeight: number,
	) {
		this.width = Math.round(Math.min(frameWidth * 0.3, frameHeight * 0.42));
		this.height = Math.round(this.width * 0.72);
		this.padding = Math.max(8, Math.round(this.width * 0.055));
		const margin = Math.round(Math.min(frameWidth, frameHeight) * 0.035);
		this.x = input.position.endsWith('right') ? frameWidth - this.width - margin : margin;
		this.y = input.position.startsWith('bottom') ? frameHeight - this.height - margin : margin;

		const minLatitude = Math.min(...input.points.map((point) => point.latitude));
		const maxLatitude = Math.max(...input.points.map((point) => point.latitude));
		const meanLatitude = (minLatitude + maxLatitude) / 2;
		const longitudeScale = Math.max(0.01, Math.cos((meanLatitude * Math.PI) / 180));
		const projected = input.points.map((point) => ({
			point,
			x: point.longitude * longitudeScale,
			y: -point.latitude,
		}));
		const minX = Math.min(...projected.map((point) => point.x));
		const maxX = Math.max(...projected.map((point) => point.x));
		const minY = Math.min(...projected.map((point) => point.y));
		const maxY = Math.max(...projected.map((point) => point.y));
		const mapTop = this.padding;
		const mapBottom = this.height - Math.round(this.width * 0.2);
		const mapWidth = this.width - this.padding * 2;
		const mapHeight = Math.max(1, mapBottom - mapTop);
		const scale = Math.min(mapWidth / Math.max(maxX - minX, 1e-8), mapHeight / Math.max(maxY - minY, 1e-8));
		const offsetX = this.padding + (mapWidth - (maxX - minX) * scale) / 2;
		const offsetY = mapTop + (mapHeight - (maxY - minY) * scale) / 2;
		this.points = projected.map(({ point, x, y }) => ({
			...point,
			x: offsetX + (x - minX) * scale,
			y: offsetY + (y - minY) * scale,
		}));
		this.base = new OffscreenCanvas(this.width, this.height);
		const baseContext = this.base.getContext('2d');
		if (!baseContext) throw new Error('Could not create the GPS mini map.');
		baseContext.fillStyle = 'rgba(10, 18, 16, 0.82)';
		baseContext.beginPath();
		baseContext.roundRect(0, 0, this.width, this.height, Math.round(this.width * 0.06));
		baseContext.fill();
		baseContext.lineCap = 'round';
		baseContext.lineJoin = 'round';
		baseContext.strokeStyle = 'rgba(255, 255, 255, 0.35)';
		baseContext.lineWidth = Math.max(2, this.width * 0.012);
		baseContext.beginPath();
		this.points.forEach((point, index) => index === 0
			? baseContext.moveTo(point.x, point.y)
			: baseContext.lineTo(point.x, point.y));
		baseContext.stroke();

		const firstTimestamp = input.points[0].timestamp;
		if (firstTimestamp === null) {
			this.startTime = null;
		} else if (input.clipCreatedAt !== null) {
			this.startTime = input.clipCreatedAt;
		} else if (input.clipLocation) {
			let nearest = input.points[0];
			let nearestDistance = distanceSquared(input.clipLocation, nearest);
			for (const point of input.points.slice(1)) {
				const distance = distanceSquared(input.clipLocation, point);
				if (distance < nearestDistance) {
					nearest = point;
					nearestDistance = distance;
				}
			}
			this.startTime = nearest.timestamp;
		} else {
			this.startTime = firstTimestamp;
		}
	}

	private pointAt(seconds: number): { point: PositionedGpsPoint; speed: number | null; upperIndex: number } | null {
		const timed = this.startTime !== null;
		const target = timed
			? this.startTime! + seconds * 1000
			: (Math.min(1, seconds / Math.max(this.input.clipDuration, 0.001)) * (this.points.length - 1));
		const first = timed ? this.points[0].timestamp! : 0;
		const last = timed ? this.points[this.points.length - 1].timestamp! : this.points.length - 1;
		if (target < first || target > last) return null;

		let low = 1;
		let high = this.points.length - 1;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((timed ? this.points[middle].timestamp! : middle) < target) low = middle + 1;
			else high = middle;
		}
		const upper = low;
		const before = this.points[Math.max(0, upper - 1)];
		const after = this.points[Math.min(upper, this.points.length - 1)];
		const beforeValue = timed ? before.timestamp! : upper - 1;
		const afterValue = timed ? after.timestamp! : upper;
		const ratio = afterValue === beforeValue ? 0 : (target - beforeValue) / (afterValue - beforeValue);
		const interpolate = (a: number, b: number) => a + (b - a) * ratio;
		let speed = before.speed ?? after.speed;
		if (speed === null && timed && after.timestamp! > before.timestamp!) {
			speed = distanceMetres(before, after) / ((after.timestamp! - before.timestamp!) / 1000);
		}
		return {
			point: {
				latitude: interpolate(before.latitude, after.latitude),
				longitude: interpolate(before.longitude, after.longitude),
				elevation: before.elevation === null || after.elevation === null
					? before.elevation ?? after.elevation
					: interpolate(before.elevation, after.elevation),
				speed,
				timestamp: timed ? target : null,
				x: interpolate(before.x, after.x),
				y: interpolate(before.y, after.y),
			},
			speed,
			upperIndex: upper,
		};
	}

	draw(context: OffscreenCanvasRenderingContext2D, seconds: number): void {
		const current = this.pointAt(seconds);
		if (!current) return;
		context.save();
		context.translate(this.x, this.y);
		context.drawImage(this.base, 0, 0);
		context.lineCap = 'round';
		context.lineJoin = 'round';
		context.strokeStyle = '#79d6a8';
		context.lineWidth = Math.max(2, this.width * 0.018);
		context.beginPath();
		context.moveTo(this.points[0].x, this.points[0].y);
		for (const point of this.points.slice(1, current.upperIndex)) {
			context.lineTo(point.x, point.y);
		}
		context.lineTo(current.point.x, current.point.y);
		context.stroke();

		const markerRadius = Math.max(4, this.width * 0.032);
		context.fillStyle = '#ffffff';
		context.beginPath();
		context.arc(current.point.x, current.point.y, markerRadius * 1.7, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = '#e75d5d';
		context.beginPath();
		context.arc(current.point.x, current.point.y, markerRadius, 0, Math.PI * 2);
		context.fill();

		const fontSize = Math.max(10, Math.round(this.width * 0.075));
		context.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
		context.textBaseline = 'bottom';
		context.fillStyle = '#ffffff';
		const labels = [
			current.speed === null ? null : `${Math.round(current.speed * 3.6)} km/h`,
			current.point.elevation === null ? null : `${Math.round(current.point.elevation)} m`,
		].filter((label): label is string => Boolean(label));
		context.fillText(labels.join('  ') || `${current.point.latitude.toFixed(5)}, ${current.point.longitude.toFixed(5)}`, this.padding, this.height - this.padding);
		context.restore();
	}
}

/** Splits a canonical (48 kHz stereo) sample into a transferable planar buffer. */
const toPlanarStereo = (sample: AudioSample): Float32Array => {
	const frames = sample.numberOfFrames;
	const data = new Float32Array(frames * AUDIO_CHANNELS);
	for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
		const plane = data.subarray(channel * frames, (channel + 1) * frames);
		const sourceChannel = Math.min(channel, sample.numberOfChannels - 1);
		sample.copyTo(plane, { planeIndex: sourceChannel, format: 'f32-planar' });
	}
	return data;
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

	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(job.file) });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error('No video track');
		if (!(await videoTrack.canDecode())) throw new Error('Video codec cannot be decoded here');

		const firstTimestamp = await videoTrack.getFirstTimestamp();
		const trackDuration = await videoTrack.computeDuration();
		const limit = job.maxClipSeconds > 0 ? job.maxClipSeconds : Infinity;
		const clipDuration = Math.min(Math.max(trackDuration - firstTimestamp, 0), limit);
		if (clipDuration <= 0) throw new Error('Clip is empty');

		const readEnd = firstTimestamp + clipDuration;

		const preset = stabilizerPreset(job.stabilize);
		let stabilizer: StabilizerPlan | null = null;
		if (preset && !isCanceled()) {
			const startedAt = performance.now();
			try {
				stabilizer = await analyzeClipMotion(videoTrack, firstTimestamp, readEnd, preset, isCanceled);
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

			for await (const sample of sink_.samples(firstTimestamp, readEnd)) {
				if (isCanceled()) {
					sample.close();
					break;
				}
				const relative = sample.timestamp - firstTimestamp;
				if (!isFirstFrame && relative - lastRelative < job.minFrameSpacing) {
					sample.close();
					continue;
				}

				ctx.fillStyle = '#000000';
				ctx.fillRect(0, 0, job.width, job.height);
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
				sample.close();
				if (job.overlay) ctx.drawImage(job.overlay, job.overlayX, job.overlayY);

				const timestamp = Math.max(0, relative);
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
			for await (const sample of sink_.samples(firstTimestamp, readEnd)) {
				let normalized: AudioSample | null = null;
				try {
					if (isCanceled()) break;
					const relative = sample.timestamp - firstTimestamp;
					if (relative < -1e-6) continue;

					// The source channel layout and sample rate are irrelevant here: everything is
					// converted to one canonical format first.
					normalized = normalizer.convert(sample);
					if (normalized.numberOfFrames === 0) continue;

					const startedAt = Math.max(0, normalized.timestamp - firstTimestamp);
					const frames = normalized.numberOfFrames;
					const data = toPlanarStereo(normalized);
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
		input.dispose();
	}
}
