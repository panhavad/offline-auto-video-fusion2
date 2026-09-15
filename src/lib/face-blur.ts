/**
 * Automatic face detection and obscuring, built on the Haar cascade classifier that ships with
 * OpenCV (`objdetect`). It runs entirely on-device: the model is bundled with the app, so enabling
 * it never contacts a server and never uploads a frame anywhere.
 *
 * The pipeline per frame is deliberately cheap, because this runs inside the encode loop:
 *
 * 1. **Detect** on a heavily downscaled copy of the composited frame. Faces are large, coarse
 *    features, so a ~320 px wide grayscale copy finds them just as reliably as the full frame and
 *    is an order of magnitude faster.
 * 2. **Track** the boxes across frames. Haar detection flickers - a face that turns slightly, or
 *    catches a shadow, drops out for a few frames. Boxes therefore survive for a short while after
 *    the detector stops reporting them, which is what stops a face from flashing into view.
 * 3. **Obscure** each box on the full-resolution canvas by resampling it through a tiny buffer.
 *    Downscaling destroys the detail irreversibly; scaling back up smoothly reads as a blur, and
 *    scaling back up without smoothing reads as a pixelation.
 *
 * Detection only runs every few frames. In between, the tracked boxes are reused, which keeps the
 * cost close to that of the blur itself.
 */
import type { CascadeClassifier, Mat, RectVector, Size } from '@techstark/opencv-js';
import cascadeUrl from '../assets/haarcascade_frontalface_default.xml?url';
import type { OpenCvRuntime } from './opencv';
import type { FaceBlurSetting } from '../types';

/** Long edge the detector runs at. Faces are coarse features; more pixels only cost time. */
const DETECTION_LONG_EDGE = 360;

/** Frames between two detection passes. Tracked boxes cover the frames in between. */
const DETECTION_INTERVAL = 2;

/** Detection passes a box survives without being re-detected, so brief dropouts stay covered. */
const TRACK_LIFETIME = 6;

/** Overlap at which a fresh detection is considered to be the same face as a tracked one. */
const MATCH_OVERLAP = 0.25;

/** Smallest face the detector will report, as a fraction of the detection long edge. */
const MIN_FACE_FRACTION = 0.06;

/** Haar pyramid step. Smaller finds more faces at more scales, and costs proportionally more. */
const SCALE_FACTOR = 1.15;

/** Neighbouring detections required to accept a box. Higher rejects more false positives. */
const MIN_NEIGHBORS = 5;

/** Edge of the square buffer a face region is resampled through. */
const SCRATCH_EDGE = 96;

export const FACE_BLUR_LABELS: Record<FaceBlurSetting, string> = {
	off: 'off',
	blur: 'blurred faces',
	strong: 'strongly blurred faces',
	pixelate: 'pixelated faces',
};

interface FaceBlurPreset {
	/** How far a detected box grows on each side, as a fraction of its size. */
	padding: number;
	/** How far the region is downscaled before being drawn back. Higher destroys more detail. */
	coarseness: number;
	/** Hard blocks instead of a smooth blur. */
	pixelate: boolean;
}

const PRESETS: Record<Exclude<FaceBlurSetting, 'off'>, FaceBlurPreset> = {
	blur: { padding: 0.2, coarseness: 18, pixelate: false },
	strong: { padding: 0.32, coarseness: 34, pixelate: false },
	pixelate: { padding: 0.2, coarseness: 18, pixelate: true },
};

const isFaceBlurEnabled = (setting: FaceBlurSetting): setting is Exclude<FaceBlurSetting, 'off'> =>
	setting !== 'off';

export const faceBlurPreset = (setting: FaceBlurSetting): FaceBlurPreset | null =>
	isFaceBlurEnabled(setting) ? PRESETS[setting] : null;

interface TrackedFace {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Detection passes this box may still be drawn for without being seen again. */
	life: number;
}

const overlap = (a: TrackedFace, b: TrackedFace): number => {
	const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
	const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
	const intersection = x * y;
	if (intersection <= 0) return 0;
	return intersection / (a.width * a.height + b.width * b.height - intersection);
};

let classifierPromise: Promise<CascadeClassifier> | null = null;

/**
 * Loads the cascade once per worker. The XML is written into the Emscripten filesystem because
 * `CascadeClassifier.load` only reads from there, and parsing it is slow enough to be worth
 * sharing between the render lanes that run side by side in one worker.
 */
export const loadFaceClassifier = (cv: OpenCvRuntime): Promise<CascadeClassifier> => {
	if (!classifierPromise) {
		classifierPromise = (async () => {
			const response = await fetch(cascadeUrl);
			if (!response.ok) throw new Error(`the model could not be read (HTTP ${response.status})`);
			const model = new Uint8Array(await response.arrayBuffer());
			const path = 'haarcascade_frontalface_default.xml';
			cv.FS_createDataFile('/', path, model, true, false, false);
			const classifier = new cv.CascadeClassifier();
			if (!classifier.load(path)) {
				classifier.delete();
				throw new Error('the model could not be parsed');
			}
			return classifier;
		})().catch((error: unknown) => {
			classifierPromise = null;
			throw error;
		});
	}
	return classifierPromise;
};

/** Detects and obscures faces on the frames of a single clip. Sized once, reused for every frame. */
export class FaceBlurrer {
	private readonly detection: OffscreenCanvas;
	private readonly detectionCtx: OffscreenCanvasRenderingContext2D;
	private readonly scratch: OffscreenCanvas;
	private readonly scratchCtx: OffscreenCanvasRenderingContext2D;
	private readonly rgba: Mat;
	private readonly gray: Mat;
	private readonly found: RectVector;
	private readonly minSize: Size;
	private readonly maxSize: Size;
	private readonly scale: number;
	private tracked: TrackedFace[] = [];
	private frame = 0;
	private disposed = false;

	constructor(
		private readonly cv: OpenCvRuntime,
		private readonly classifier: CascadeClassifier,
		private readonly preset: FaceBlurPreset,
		frameWidth: number,
		frameHeight: number,
	) {
		// Scaling by the long edge keeps the cost - and the smallest detectable face - identical
		// for landscape and portrait clips, instead of making portrait frames three times dearer.
		const ratio = Math.min(1, DETECTION_LONG_EDGE / Math.max(1, frameWidth, frameHeight));
		const width = Math.max(48, Math.round(frameWidth * ratio));
		const height = Math.max(48, Math.round(frameHeight * ratio));
		this.scale = frameWidth / width;

		this.detection = new OffscreenCanvas(width, height);
		const detectionCtx = this.detection.getContext('2d', { alpha: false, willReadFrequently: true });
		if (!detectionCtx) throw new Error('Could not create the face detection context.');
		this.detectionCtx = detectionCtx;

		this.scratch = new OffscreenCanvas(SCRATCH_EDGE, SCRATCH_EDGE);
		const scratchCtx = this.scratch.getContext('2d', { alpha: false });
		if (!scratchCtx) throw new Error('Could not create the face blur context.');
		this.scratchCtx = scratchCtx;

		this.rgba = new cv.Mat(height, width, cv.CV_8UC4);
		this.gray = new cv.Mat(height, width, cv.CV_8UC1);
		this.found = new cv.RectVector();
		const minimum = Math.max(16, Math.round(Math.max(width, height) * MIN_FACE_FRACTION));
		this.minSize = new cv.Size(minimum, minimum);
		this.maxSize = new cv.Size(0, 0);
	}

	/** Detects on the current frame and draws every tracked face back over it, obscured. */
	apply(canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D): void {
		if (this.disposed) return;
		if (this.frame % DETECTION_INTERVAL === 0) this.detect(canvas);
		this.frame++;
		for (const face of this.tracked) this.obscure(canvas, ctx, face);
	}

	private detect(canvas: OffscreenCanvas): void {
		const cv = this.cv;
		const { width, height } = this.detection;
		this.detectionCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
		this.rgba.data.set(this.detectionCtx.getImageData(0, 0, width, height).data);
		cv.cvtColor(this.rgba, this.gray, cv.COLOR_RGBA2GRAY);
		// Faces in video are routinely back-lit or in shadow; equalizing first is what makes the
		// cascade find them in anything other than even lighting.
		cv.equalizeHist(this.gray, this.gray);
		this.classifier.detectMultiScale(
			this.gray,
			this.found,
			SCALE_FACTOR,
			MIN_NEIGHBORS,
			0,
			this.minSize,
			this.maxSize,
		);

		for (const face of this.tracked) face.life--;

		const count = this.found.size();
		for (let index = 0; index < count; index++) {
			const rect = this.found.get(index);
			const fresh: TrackedFace = {
				x: rect.x * this.scale,
				y: rect.y * this.scale,
				width: rect.width * this.scale,
				height: rect.height * this.scale,
				life: TRACK_LIFETIME,
			};
			const existing = this.tracked.find((candidate) => overlap(candidate, fresh) >= MATCH_OVERLAP);
			if (existing) {
				Object.assign(existing, fresh);
			} else {
				this.tracked.push(fresh);
			}
		}

		this.tracked = this.tracked.filter((face) => face.life > 0);
	}

	private obscure(
		canvas: OffscreenCanvas,
		ctx: OffscreenCanvasRenderingContext2D,
		face: TrackedFace,
	): void {
		const { padding, coarseness, pixelate } = this.preset;
		const padX = face.width * padding;
		const padY = face.height * padding;
		const x = Math.max(0, Math.floor(face.x - padX));
		const y = Math.max(0, Math.floor(face.y - padY));
		const width = Math.min(canvas.width - x, Math.ceil(face.width + padX * 2));
		const height = Math.min(canvas.height - y, Math.ceil(face.height + padY * 2));
		if (width < 2 || height < 2) return;

		const sampleWidth = Math.max(1, Math.min(SCRATCH_EDGE, Math.round(width / coarseness)));
		const sampleHeight = Math.max(1, Math.min(SCRATCH_EDGE, Math.round(height / coarseness)));
		this.scratchCtx.imageSmoothingEnabled = true;
		this.scratchCtx.drawImage(canvas, x, y, width, height, 0, 0, sampleWidth, sampleHeight);

		ctx.save();
		if (!pixelate) {
			// An ellipse follows a head far better than a rectangle, so the covered area does not
			// announce itself as a pasted-on box.
			ctx.beginPath();
			ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
			ctx.clip();
		}
		ctx.imageSmoothingEnabled = !pixelate;
		ctx.drawImage(this.scratch, 0, 0, sampleWidth, sampleHeight, x, y, width, height);
		ctx.restore();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.rgba.delete();
		this.gray.delete();
		this.found.delete();
	}
}
