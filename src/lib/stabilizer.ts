/**
 * Software video stabilization built on OpenCV.js (`@techstark/opencv-js`), which supplies the
 * battle-tested implementations this needs: Shi-Tomasi corner detection, pyramidal Lucas-Kanade
 * optical flow, and RANSAC-filtered affine estimation.
 *
 * The pipeline is the classic two-pass one:
 *
 * 1. **Analyze** every frame of a clip at a low resolution and estimate how the picture moved
 *    between consecutive frames. Summing those deltas gives the raw camera trajectory.
 * 2. **Smooth** that trajectory. The gap between the smoothed and the raw trajectory is the
 *    correction each frame needs, which is what turns a shaky path into a deliberate-looking one.
 * 3. **Render** the frame shifted and rotated by that correction, zoomed just enough to keep the
 *    borders it uncovers out of the picture.
 *
 * Steps 1 and 2 run per clip before it is encoded, so the correction for a frame is always known
 * before that frame is drawn and the encoder never waits on analysis. The OpenCV build is ~10 MB,
 * so it is imported lazily: a merge with the stabilizer off never downloads a byte of it.
 *
 * Only translation and rotation are ever corrected. OpenCV's `estimateAffine2D` also reports scale
 * and shear, but in handheld footage those terms are parallax and noise rather than camera shake,
 * and "correcting" them warps the picture instead of steadying it.
 */
import type { Mat } from '@techstark/opencv-js';
import type { OpenCvRuntime } from './opencv';
import type { StabilizerSetting } from '../types';

/** Long edge of the frames the motion analysis runs on. Small is fine — and much faster. */
export const ANALYSIS_LONG_EDGE = 480;

/** Below this many tracked points a frame-to-frame estimate is not trustworthy. */
const MIN_TRACKED_POINTS = 12;
const MAX_TRACKED_POINTS = 220;

/** Motion beyond this fraction of the frame is a cut or a tracking failure, not camera shake. */
const MAX_PLAUSIBLE_SHIFT = 0.2;

/** Two box passes approximate a Gaussian, which looks noticeably smoother than a single one. */
const SMOOTHING_PASSES = 2;

/** Share of the crop margin that the translation correction may use up; the rest pays for rotation. */
const TRANSLATION_BUDGET = 0.35;
const ROTATION_BUDGET = 0.15;

/** A little slack on top of the measured requirement, so rounding never uncovers a border. */
const ZOOM_SAFETY = 1.05;

/** OpenCV builds disagree on the spelling of the two flags, and neither is in the type defs. */
const TERM_CRITERIA_COUNT = 1;
const TERM_CRITERIA_EPS = 2;

/** `cv.RANSAC`; hard-coded because the constant is not exported by every OpenCV.js build. */
const RANSAC = 8;

/** Reprojection tolerance in analysis pixels — tight, because the analysis frame is small. */
const RANSAC_THRESHOLD = 2.5;

export interface StabilizerPreset {
	/** Half-width of the moving average over the camera trajectory, in frames. */
	smoothingRadius: number;
	/** Largest fraction of the frame that may be zoomed away to hide uncovered borders. */
	cropMargin: number;
}

export const STABILIZER_PRESETS: Record<Exclude<StabilizerSetting, 'off'>, StabilizerPreset> = {
	light: { smoothingRadius: 10, cropMargin: 0.04 },
	standard: { smoothingRadius: 22, cropMargin: 0.08 },
	strong: { smoothingRadius: 40, cropMargin: 0.14 },
};

export const STABILIZER_LABELS: Record<StabilizerSetting, string> = {
	off: 'off',
	light: 'light',
	standard: 'standard',
	strong: 'strong',
};

const isStabilizerEnabled = (setting: StabilizerSetting): setting is Exclude<StabilizerSetting, 'off'> =>
	setting !== 'off';

/** Tuning for a setting, or null when the stabilizer is off and no analysis should run at all. */
export const stabilizerPreset = (setting: StabilizerSetting): StabilizerPreset | null =>
	isStabilizerEnabled(setting) ? STABILIZER_PRESETS[setting] : null;

/** Per-frame corrections for one clip, indexed by the source timestamps they were measured at. */
export interface StabilizerPlan {
	/** Source timestamps in seconds, ascending. */
	timestamps: Float64Array;
	/** Horizontal correction as a fraction of the drawn frame width. */
	dx: Float32Array;
	/** Vertical correction as a fraction of the drawn frame height. */
	dy: Float32Array;
	/** Clockwise correction in radians. */
	rotation: Float32Array;
	/** Uniform zoom that keeps the corrections from uncovering the frame border. */
	zoom: number;
	/** How many frames produced a usable motion estimate — a quality indicator for the log. */
	trackedFrames: number;
}

export interface FrameCorrection {
	dx: number;
	dy: number;
	rotation: number;
}

const NO_CORRECTION: FrameCorrection = { dx: 0, dy: 0, rotation: 0 };

// ---------------------------------------------------------------------------
// OpenCV.js runtime
// ---------------------------------------------------------------------------

type OpenCvModule = typeof import('@techstark/opencv-js');

const RUNTIME_POLL_MS = 25;
const RUNTIME_TIMEOUT_MS = 60_000;

let runtimePromise: Promise<OpenCvRuntime> | null = null;

const isReady = (cv: OpenCvRuntime): boolean => typeof (cv as { Mat?: unknown }).Mat === 'function';

/**
 * Belt and braces: {@link openCvRuntime} already strips the `then` method that would otherwise make
 * the promise machinery unwrap this object forever, but nothing here may ever resolve a promise
 * with a thenable module, so the guarantee is repeated at the only place that does.
 */
const detachThenable = (cv: OpenCvRuntime): OpenCvRuntime => {
	delete (cv as { then?: unknown }).then;
	return cv;
};

/**
 * Waits for the WASM runtime. `onRuntimeInitialized` is the documented hook, but it is only useful
 * while the runtime is still booting - polling covers the case where it finished before we looked.
 */
const waitForRuntime = (cv: OpenCvRuntime): Promise<OpenCvRuntime> =>
	new Promise((resolve, reject) => {
		if (isReady(cv)) {
			resolve(detachThenable(cv));
			return;
		}

		const started = Date.now();
		let settled = false;
		const finish = () => {
			if (settled) return false;
			settled = true;
			clearInterval(timer);
			return true;
		};

		const timer = setInterval(() => {
			if (isReady(cv)) {
				if (finish()) resolve(detachThenable(cv));
			} else if (Date.now() - started > RUNTIME_TIMEOUT_MS) {
				if (finish()) reject(new Error('OpenCV did not finish loading in time'));
			}
		}, RUNTIME_POLL_MS);

		cv.onRuntimeInitialized = () => {
			if (finish()) resolve(detachThenable(cv));
		};
	});

/** Loads OpenCV.js once and keeps it around; a failed load can be retried on the next merge. */
export const loadOpenCv = (): Promise<OpenCvRuntime> => {
	if (!runtimePromise) {
		// Imports the local wrapper, never the package itself: its module object is thenable and
		// would make this very `import()` hang forever. See src/lib/opencv.ts.
		runtimePromise = import('./opencv')
			.then(({ openCvRuntime }) => waitForRuntime(openCvRuntime()))
			.catch((error: unknown) => {
				runtimePromise = null;
				throw error;
			});
	}
	return runtimePromise;
};

// ---------------------------------------------------------------------------
// Motion analysis
// ---------------------------------------------------------------------------

/**
 * Feeds frames of a single clip through OpenCV and accumulates the camera trajectory. Every OpenCV
 * matrix is freed explicitly - the WASM heap is not garbage collected.
 */
export class ClipMotionAnalyzer {
	private readonly cv: OpenCvRuntime;
	private readonly width: number;
	private readonly height: number;
	private readonly minDistance: number;
	private readonly winSize: InstanceType<OpenCvModule['Size']>;
	private readonly criteria: InstanceType<OpenCvModule['TermCriteria']>;

	private rgba: Mat;
	private gray: Mat;
	private previous: Mat;
	private hasPrevious = false;
	private disposed = false;

	private readonly timestamps: number[] = [];
	private readonly trajectoryX: number[] = [];
	private readonly trajectoryY: number[] = [];
	private readonly trajectoryAngle: number[] = [];
	private x = 0;
	private y = 0;
	private angle = 0;
	private tracked = 0;

	constructor(cv: OpenCvRuntime, width: number, height: number) {
		this.cv = cv;
		this.width = width;
		this.height = height;
		this.minDistance = Math.max(8, Math.round(Math.max(width, height) / 40));
		this.winSize = new cv.Size(21, 21);
		this.criteria = new cv.TermCriteria(TERM_CRITERIA_COUNT | TERM_CRITERIA_EPS, 30, 0.01);
		this.rgba = new cv.Mat(height, width, cv.CV_8UC4);
		this.gray = new cv.Mat(height, width, cv.CV_8UC1);
		this.previous = new cv.Mat(height, width, cv.CV_8UC1);
	}

	get frameCount(): number {
		return this.timestamps.length;
	}

	/** Adds one analysis frame. `pixels` must be RGBA of exactly the configured size. */
	push(pixels: Uint8ClampedArray, timestamp: number): void {
		if (this.disposed) return;
		const cv = this.cv;

		this.rgba.data.set(pixels);
		cv.cvtColor(this.rgba, this.gray, cv.COLOR_RGBA2GRAY);

		if (this.hasPrevious) {
			const motion = this.estimateMotion();
			if (motion) {
				this.x += motion.dx;
				this.y += motion.dy;
				this.angle += motion.rotation;
				this.tracked++;
			}
		}

		this.timestamps.push(timestamp);
		this.trajectoryX.push(this.x);
		this.trajectoryY.push(this.y);
		this.trajectoryAngle.push(this.angle);

		const swap = this.previous;
		this.previous = this.gray;
		this.gray = swap;
		this.hasPrevious = true;
	}

	/** Motion of the picture between the previous and the current frame, in analysis pixels. */
	private estimateMotion(): FrameCorrection | null {
		const cv = this.cv;
		const previousPoints = new cv.Mat();
		const nextPoints = new cv.Mat();
		const status = new cv.Mat();
		const error = new cv.Mat();
		let from: Mat | null = null;
		let to: Mat | null = null;
		let inliers: Mat | null = null;
		let affine: Mat | null = null;

		try {
			cv.goodFeaturesToTrack(this.previous, previousPoints, MAX_TRACKED_POINTS, 0.01, this.minDistance);
			if (previousPoints.rows < MIN_TRACKED_POINTS) return null;

			cv.calcOpticalFlowPyrLK(
				this.previous,
				this.gray,
				previousPoints,
				nextPoints,
				status,
				error,
				this.winSize,
				3,
				this.criteria,
			);

			const before: number[] = [];
			const after: number[] = [];
			const flags = status.data;
			const source = previousPoints.data32F;
			const target = nextPoints.data32F;
			for (let index = 0; index < flags.length; index++) {
				if (!flags[index]) continue;
				before.push(source[index * 2], source[index * 2 + 1]);
				after.push(target[index * 2], target[index * 2 + 1]);
			}
			if (before.length < MIN_TRACKED_POINTS * 2) return null;

			from = cv.matFromArray(before.length / 2, 1, cv.CV_32FC2, before);
			to = cv.matFromArray(after.length / 2, 1, cv.CV_32FC2, after);
			inliers = new cv.Mat();
			// RANSAC throws out the points that belong to something moving *through* the shot
			// rather than to the camera, which is what makes this survive real footage.
			affine = cv.estimateAffine2D(from, to, inliers, RANSAC, RANSAC_THRESHOLD) as Mat;
			if (!affine || affine.empty() || affine.rows !== 2 || affine.cols !== 3) return null;

			// Only translation and rotation are kept: a scale or shear term from the estimate is
			// almost always parallax or noise, and "correcting" it would warp the picture.
			const dx = affine.doubleAt(0, 2);
			const dy = affine.doubleAt(1, 2);
			const rotation = Math.atan2(affine.doubleAt(1, 0), affine.doubleAt(0, 0));
			if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(rotation)) return null;
			// A cut or a failed track produces a jump no camera shake ever would; treating it as
			// "no motion" keeps the trajectory - and therefore the whole clip - from lurching.
			if (Math.abs(dx) > this.width * MAX_PLAUSIBLE_SHIFT) return null;
			if (Math.abs(dy) > this.height * MAX_PLAUSIBLE_SHIFT) return null;

			return { dx, dy, rotation };
		} catch {
			return null;
		} finally {
			previousPoints.delete();
			nextPoints.delete();
			status.delete();
			error.delete();
			from?.delete();
			to?.delete();
			inliers?.delete();
			affine?.delete();
		}
	}

	/** Turns the accumulated trajectory into the per-frame corrections for the render pass. */
	finish(preset: StabilizerPreset): StabilizerPlan | null {
		const count = this.timestamps.length;
		if (count < 2 || this.tracked === 0) return null;

		const smoothX = smooth(this.trajectoryX, preset.smoothingRadius);
		const smoothY = smooth(this.trajectoryY, preset.smoothingRadius);
		const smoothAngle = smooth(this.trajectoryAngle, preset.smoothingRadius);

		const maxTranslation = preset.cropMargin * TRANSLATION_BUDGET;
		const maxRotation = preset.cropMargin * ROTATION_BUDGET;

		const dx = new Float32Array(count);
		const dy = new Float32Array(count);
		const rotation = new Float32Array(count);
		let required = 0;

		for (let index = 0; index < count; index++) {
			const shiftX = saturate((smoothX[index] - this.trajectoryX[index]) / this.width, maxTranslation);
			const shiftY = saturate((smoothY[index] - this.trajectoryY[index]) / this.height, maxTranslation);
			const turn = saturate(smoothAngle[index] - this.trajectoryAngle[index], maxRotation);
			dx[index] = shiftX;
			dy[index] = shiftY;
			rotation[index] = turn;
			// A shift of s only stays hidden while the zoom adds s to *both* sides of the frame,
			// and a rotation of a costs roughly the same again on the corners.
			required = Math.max(required, 2 * (Math.max(Math.abs(shiftX), Math.abs(shiftY)) + Math.abs(turn)));
		}

		return {
			timestamps: Float64Array.from(this.timestamps),
			dx,
			dy,
			rotation,
			// Steady footage needs no zoom at all, so the crop margin is a ceiling, not a cost.
			zoom: 1 + Math.min(preset.cropMargin, required * ZOOM_SAFETY),
			trackedFrames: this.tracked,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.rgba.delete();
		this.gray.delete();
		this.previous.delete();
	}
}

// ---------------------------------------------------------------------------
// Trajectory smoothing and playback
// ---------------------------------------------------------------------------

/**
 * Smooths the camera trajectory: a repeated box blur (which approximates a Gaussian) applied to
 * the trajectory *after* its linear trend has been removed.
 *
 * Detrending is what separates "the operator is panning" from "the operator's hands are shaking".
 * A box window is asymmetric at the first and last frames, so it reads a steady pan as a slowing
 * one and asks for a correction that grows with the length of the clip - which is exactly the
 * sideways drag that naive stabilizers show at the start and end of every shot. Taking the
 * straight line out first makes a constant-velocity pan survive untouched, whatever the window
 * does at the edges, and leaves the blur to do the only job it is good at: killing the wobble.
 */
const smooth = (values: readonly number[], radius: number): Float64Array => {
	const count = values.length;
	if (count === 0) return new Float64Array(0);
	const window = Math.max(1, Math.min(Math.round(radius), count));
	if (window <= 1 || count < 3) return Float64Array.from(values);

	// Least-squares line through the trajectory; `index` is the sample number.
	let sumIndex = 0;
	let sumValue = 0;
	let sumIndexSquared = 0;
	let sumIndexValue = 0;
	for (let index = 0; index < count; index++) {
		sumIndex += index;
		sumValue += values[index];
		sumIndexSquared += index * index;
		sumIndexValue += index * values[index];
	}
	const denominator = count * sumIndexSquared - sumIndex * sumIndex;
	const slope = denominator !== 0 ? (count * sumIndexValue - sumIndex * sumValue) / denominator : 0;
	const intercept = (sumValue - slope * sumIndex) / count;

	let current = new Float64Array(count);
	for (let index = 0; index < count; index++) current[index] = values[index] - (intercept + slope * index);

	const prefix = new Float64Array(count + 1);
	for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
		for (let index = 0; index < count; index++) prefix[index + 1] = prefix[index] + current[index];

		const next = new Float64Array(count);
		for (let index = 0; index < count; index++) {
			const start = Math.max(0, index - window);
			const end = Math.min(count - 1, index + window);
			next[index] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
		}
		current = next;
	}

	for (let index = 0; index < count; index++) current[index] += intercept + slope * index;
	return current;
};

/** Smoothly limits a value to ±limit, so a clamped stretch never shows up as a hard stop. */
const saturate = (value: number, limit: number): number =>
	limit > 0 ? limit * Math.tanh(value / limit) : 0;

/** The correction measured for the frame closest to `timestamp`. */
const correctionAt = (plan: StabilizerPlan, timestamp: number): FrameCorrection => {
	const times = plan.timestamps;
	if (times.length === 0) return NO_CORRECTION;

	let low = 0;
	let high = times.length - 1;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (times[middle] < timestamp) low = middle + 1;
		else high = middle;
	}
	// `low` is the first frame at or after the timestamp; the one before it may be closer.
	let index = low;
	if (index > 0 && Math.abs(times[index - 1] - timestamp) <= Math.abs(times[index] - timestamp)) index -= 1;

	return { dx: plan.dx[index], dy: plan.dy[index], rotation: plan.rotation[index] };
};

/**
 * Applies a clip's stabilization to the current canvas transform. The caller draws right after,
 * inside its own `save()` / `restore()` pair.
 *
 * `content` is the size the frame is actually drawn at, which is what the corrections are relative
 * to - using the canvas size instead would over-correct every letterboxed clip.
 */
export const applyStabilizerTransform = (
	context: OffscreenCanvasRenderingContext2D,
	plan: StabilizerPlan,
	timestamp: number,
	content: { width: number; height: number },
	frame: { width: number; height: number },
): void => {
	const correction = correctionAt(plan, timestamp);
	const centerX = frame.width / 2;
	const centerY = frame.height / 2;

	context.translate(centerX, centerY);
	context.scale(plan.zoom, plan.zoom);
	context.rotate(correction.rotation);
	context.translate(-centerX, -centerY);
	context.translate(correction.dx * content.width, correction.dy * content.height);
};

/** Size the frame is drawn at inside the output frame, mirroring `VideoSample.drawWithFit`. */
export const drawnContentSize = (
	sourceWidth: number,
	sourceHeight: number,
	frameWidth: number,
	frameHeight: number,
	fit: 'contain' | 'cover',
): { width: number; height: number } => {
	if (!(sourceWidth > 0) || !(sourceHeight > 0)) return { width: frameWidth, height: frameHeight };
	const scale =
		fit === 'cover'
			? Math.max(frameWidth / sourceWidth, frameHeight / sourceHeight)
			: Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
	return { width: sourceWidth * scale, height: sourceHeight * scale };
};
