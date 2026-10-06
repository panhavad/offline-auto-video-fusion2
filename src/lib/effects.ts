/**
 * Cut transitions, blurred-background framing and the animated title intro used by highlight
 * reels. Everything here only needs the frame of the clip that is currently being drawn, so it
 * runs unchanged inside the render lanes (where clips are composited concurrently and never see
 * each other's frames) and in the live preview on the page.
 *
 * A transition is split across the cut: the outgoing clip performs the first half (zooming in,
 * whipping away, flashing up…) and the incoming clip the mirrored second half, which reads as a
 * single continuous effect - the way short-form editors build their "zoom" and "whip" cuts.
 */
import type { TransitionStyle } from '../types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type DrawableCanvas = HTMLCanvasElement | OffscreenCanvas;

export type CutStyle = Exclude<TransitionStyle, 'none' | 'mix'>;

/** Order `mix` cycles through, chosen so that two neighbouring cuts never look alike. */
const MIX_SEQUENCE: CutStyle[] = ['zoom', 'whip', 'flash', 'spin', 'glitch', 'zoom', 'whip', 'dip'];

export const TRANSITION_LABELS: Record<TransitionStyle, string> = {
	none: 'Hard cut',
	mix: 'Mix (varies every cut)',
	zoom: 'Zoom punch',
	whip: 'Whip pan',
	flash: 'Flash',
	glitch: 'Glitch',
	spin: 'Spin',
	dip: 'Dip to black',
};

export interface SegmentTransitions {
	/** Effect the clip starts with (second half of the previous cut), or null for a hard start. */
	in: CutStyle | null;
	/** Effect the clip ends with (first half of the next cut), or null for a hard end. */
	out: CutStyle | null;
	/** Length of each half, in seconds. */
	seconds: number;
}

export interface FrameEffect {
	style: CutStyle;
	/** 0 = untouched … 1 = right at the cut. */
	strength: number;
	/** `out` while leaving a clip, `in` while entering the next one. */
	side: 'in' | 'out';
	/** Stable per-frame seed, so random-looking effects render identically on every run. */
	seed: number;
}

/** Half of a cut, in seconds: snappy at two-second segments, never more than a fifth of a clip. */
export const transitionHalfSeconds = (segmentSeconds: number): number =>
	Math.max(0, Math.min(0.2, segmentSeconds * 0.18));

const cutStyle = (style: TransitionStyle, cutIndex: number): CutStyle | null => {
	if (style === 'none') return null;
	if (style === 'mix') return MIX_SEQUENCE[cutIndex % MIX_SEQUENCE.length];
	return style;
};

/** Transitions of clip `index` out of `count`; the reel itself starts and ends on a hard cut. */
export const segmentTransitions = (
	style: TransitionStyle,
	index: number,
	count: number,
	segmentSeconds: number,
): SegmentTransitions | null => {
	if (style === 'none' || count < 2) return null;
	return {
		in: index > 0 ? cutStyle(style, index - 1) : null,
		out: index < count - 1 ? cutStyle(style, index) : null,
		seconds: transitionHalfSeconds(segmentSeconds),
	};
};

/**
 * Effect for the frame shown at `time` (seconds into the segment). `frameSeconds` is the frame's
 * own duration, so the last frame before the cut lands exactly on full strength.
 */
export const effectAt = (
	transitions: SegmentTransitions | null,
	time: number,
	frameSeconds: number,
	segmentSeconds: number,
	seed = 0,
): FrameEffect | null => {
	if (!transitions || transitions.seconds <= 0) return null;
	const half = transitions.seconds;
	if (transitions.in && time < half) {
		return { style: transitions.in, strength: 1 - Math.max(0, time) / half, side: 'in', seed: seed + Math.floor(time * 60) };
	}
	const end = time + frameSeconds;
	if (transitions.out && end > segmentSeconds - half) {
		const strength = Math.min(1, (end - (segmentSeconds - half)) / half);
		return { style: transitions.out, strength, side: 'out', seed: seed + 1000 + Math.floor(time * 60) };
	}
	return null;
};

/** Accelerates into the cut and decelerates out of it. */
const ease = (strength: number) => Math.pow(Math.min(1, Math.max(0, strength)), 1.7);

/** Small deterministic PRNG (mulberry32). */
const random = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/**
 * Draws one layer (`draw` paints it to fill a `width`×`height` frame) through the geometric part of
 * the effect: zoom, spin, whip offset and motion blur. Without an effect it simply calls `draw`.
 */
export function drawWithEffect(
	ctx: Ctx2D,
	width: number,
	height: number,
	effect: FrameEffect | null,
	draw: (ctx: Ctx2D) => void,
): void {
	if (!effect) {
		draw(ctx);
		return;
	}

	const k = ease(effect.strength);
	const unit = Math.min(width, height) / 1080;
	let scale = 1;
	let angle = 0;
	let offsetX = 0;
	let blur = 0;

	switch (effect.style) {
		case 'zoom':
			scale = 1 + 0.5 * k;
			blur = 16 * k * unit;
			break;
		case 'spin':
			// 30° at most, with enough zoom that the rotated 9:16 or 16:9 frame still covers every corner.
			angle = (effect.side === 'out' ? 1 : -1) * k * (Math.PI / 6);
			scale = 1 + 0.9 * k;
			blur = 12 * k * unit;
			break;
		case 'whip':
			// Leaves to the left, arrives from the right: one continuous pan across the cut.
			offsetX = (effect.side === 'out' ? -1 : 1) * k * width;
			blur = 28 * k * unit;
			break;
		case 'glitch': {
			const next = random(effect.seed);
			offsetX = (next() - 0.5) * 0.06 * width * k;
			scale = 1 + 0.04 * k;
			break;
		}
		case 'flash':
			scale = 1 + 0.08 * k;
			break;
		case 'dip':
			break;
	}

	ctx.save();
	if (scale !== 1 || angle !== 0) {
		ctx.translate(width / 2, height / 2);
		if (angle !== 0) ctx.rotate(angle);
		ctx.scale(scale, scale);
		ctx.translate(-width / 2, -height / 2);
	}
	if (blur >= 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;
	if (offsetX !== 0) ctx.translate(offsetX, 0);
	draw(ctx);
	if (effect.style === 'whip' && Math.abs(offsetX) > 0.5) {
		// The frame is tiled so the pan never uncovers an empty edge.
		ctx.translate(offsetX < 0 ? width : -width, 0);
		draw(ctx);
	}
	ctx.restore();
}

/** Colour part of the effect (flash, dip, glitch), applied on top of the finished picture. */
export function applyEffectOverlay(
	ctx: Ctx2D,
	canvas: DrawableCanvas,
	width: number,
	height: number,
	effect: FrameEffect | null,
): void {
	if (!effect) return;
	const k = ease(effect.strength);
	if (k <= 0.001) return;

	ctx.save();
	switch (effect.style) {
		case 'flash':
			ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * Math.sqrt(k)).toFixed(3)})`;
			ctx.fillRect(0, 0, width, height);
			break;
		case 'dip':
			ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(1, effect.strength).toFixed(3)})`;
			ctx.fillRect(0, 0, width, height);
			break;
		case 'zoom':
		case 'spin':
			ctx.fillStyle = `rgba(255, 255, 255, ${(0.18 * k).toFixed(3)})`;
			ctx.fillRect(0, 0, width, height);
			break;
		case 'glitch': {
			const next = random(effect.seed * 7 + 3);
			// Torn horizontal bands...
			const bands = 4 + Math.floor(next() * 5);
			for (let band = 0; band < bands; band++) {
				const y = Math.floor(next() * height);
				const bandHeight = Math.max(2, Math.floor((0.02 + next() * 0.09) * height));
				const shift = Math.round((next() - 0.5) * 0.25 * width * k);
				ctx.drawImage(canvas, 0, y, width, bandHeight, shift, y, width, bandHeight);
			}
			// ...a chromatic ghost...
			const split = Math.max(2, Math.round(0.012 * width * k));
			ctx.globalCompositeOperation = 'screen';
			ctx.globalAlpha = 0.35 * k;
			ctx.drawImage(canvas, split, 0);
			ctx.drawImage(canvas, -split, 0);
			// ...and RGB scanline sparks.
			ctx.globalCompositeOperation = 'source-over';
			ctx.globalAlpha = 0.7 * k;
			const lines = 3 + Math.floor(next() * 6);
			for (let line = 0; line < lines; line++) {
				ctx.fillStyle = next() > 0.5 ? '#ff2fd2' : '#22f3ff';
				ctx.fillRect(0, Math.floor(next() * height), width, Math.max(1, Math.round(height * 0.004)));
			}
			break;
		}
		case 'whip':
			break;
	}
	ctx.restore();
}

/** Downscale factor of the blurred backdrop; upscaling it again is what does most of the blur. */
const BACKDROP_SCALE = 16;

/**
 * Fills the frame with a blurred, darkened, zoomed copy of the clip - the standard way to put a
 * landscape clip into a vertical reel without black bars. Rendering it at 1/16 size and letting
 * the upscale smooth it costs a fraction of a full-resolution blur.
 */
export class BlurredBackdrop {
	private readonly canvas: OffscreenCanvas;
	private readonly ctx: OffscreenCanvasRenderingContext2D;

	constructor(width: number, height: number) {
		this.canvas = new OffscreenCanvas(
			Math.max(2, Math.ceil(width / BACKDROP_SCALE)),
			Math.max(2, Math.ceil(height / BACKDROP_SCALE)),
		);
		const ctx = this.canvas.getContext('2d', { alpha: false });
		if (!ctx) throw new Error('Could not create a 2D rendering context.');
		this.ctx = ctx;
	}

	/** `paint` must cover the whole backdrop canvas it is given. */
	draw(
		target: Ctx2D,
		width: number,
		height: number,
		paint: (ctx: OffscreenCanvasRenderingContext2D, width: number, height: number) => void,
	): void {
		this.ctx.filter = 'blur(1.5px)';
		paint(this.ctx, this.canvas.width, this.canvas.height);
		this.ctx.filter = 'none';
		target.save();
		target.imageSmoothingEnabled = true;
		target.imageSmoothingQuality = 'high';
		// Slightly oversized so the darkened blur never shows a hard frame edge.
		const bleedX = width * 0.04;
		const bleedY = height * 0.04;
		target.drawImage(this.canvas, -bleedX, -bleedY, width + bleedX * 2, height + bleedY * 2);
		target.fillStyle = 'rgba(0, 0, 0, 0.38)';
		target.fillRect(0, 0, width, height);
		target.restore();
	}
}

export const TITLE_INTRO_SECONDS = 0.6;

/** Overshoots past 1 and settles back, which reads as a "pop". */
const easeOutBack = (p: number) => {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/**
 * Draws the title bitmap; with `introTime` set (seconds since the reel started) it pops in over
 * the first {@link TITLE_INTRO_SECONDS}.
 */
export function drawTitle(
	ctx: Ctx2D,
	overlay: CanvasImageSource & { width: number; height: number },
	x: number,
	y: number,
	introTime: number | null,
): void {
	if (introTime === null || introTime >= TITLE_INTRO_SECONDS) {
		ctx.drawImage(overlay, x, y);
		return;
	}
	const p = Math.max(0, introTime) / TITLE_INTRO_SECONDS;
	const scale = 0.35 + 0.65 * easeOutBack(p);
	ctx.save();
	ctx.globalAlpha = Math.min(1, p * 3);
	ctx.translate(x + overlay.width / 2, y + overlay.height / 2);
	ctx.scale(scale, scale);
	ctx.drawImage(overlay, -overlay.width / 2, -overlay.height / 2);
	ctx.restore();
}
