/**
 * Live preview of the output: plays the exact clip sequence the encoder will produce - in the
 * output's frame shape, with its framing, transitions, title and mini map - straight from the
 * local files, without encoding anything.
 *
 * Two `<video>` elements take turns: while one plays the current segment, the other is already
 * seeked to the start of the next one, so cuts happen without a loading gap.
 */
import {
	BlurredBackdrop,
	applyEffectOverlay,
	drawTitle,
	drawWithEffect,
	effectAt,
	type SegmentTransitions,
} from './lib/effects';
import { formatDuration } from './lib/format';
import { GpsMiniMap, type GpsOverlayInput } from './lib/gps-map';
import type { SafeArea } from './lib/safe-area';
import type { FitMode } from './types';

export interface PreviewSegment {
	id: string;
	name: string;
	file: File;
	/** Seconds into the file where the segment starts. */
	start: number;
	seconds: number;
	transitions: SegmentTransitions | null;
	titleIntro: boolean;
	gps: GpsOverlayInput | null;
	seed: number;
}

export interface PreviewComposition {
	width: number;
	height: number;
	fit: FitMode;
	blurredBackdrop: boolean;
	title: { canvas: OffscreenCanvas; x: number; y: number } | null;
	/** Frame edges a social app covers; drawn as a guide when enabled, never encoded. */
	safeArea: SafeArea | null;
	segments: PreviewSegment[];
}

export interface PreviewState {
	playing: boolean;
	/** Position on the output timeline, in seconds. */
	time: number;
	duration: number;
	/** Index of the segment on screen, or -1 when there is nothing to preview. */
	index: number;
	count: number;
	name: string;
	muted: boolean;
}

/** Frame duration assumed for transition timing; only affects where the last frame lands. */
const PREVIEW_FRAME_SECONDS = 1 / 30;
const LOAD_TIMEOUT_MS = 6000;
const STATE_INTERVAL_MS = 100;

interface Slot {
	video: HTMLVideoElement;
	/** Segment this element is loaded with, or -1. */
	segment: number;
	/** Resolves true once the element shows the requested frame, false when it cannot. */
	ready: Promise<boolean>;
	ok: boolean | null;
	token: number;
}

const waitFor = (video: HTMLVideoElement, event: string, timeoutMs: number): Promise<boolean> =>
	new Promise<boolean>((resolve) => {
		const finish = (result: boolean) => {
			clearTimeout(timer);
			video.removeEventListener(event, onEvent);
			video.removeEventListener('error', onError);
			resolve(result);
		};
		const onEvent = () => finish(true);
		const onError = () => finish(false);
		const timer = setTimeout(() => finish(video.readyState >= 2), timeoutMs);
		video.addEventListener(event, onEvent);
		video.addEventListener('error', onError);
	});

const fittedRect = (sourceWidth: number, sourceHeight: number, width: number, height: number, fit: FitMode) => {
	const scale =
		fit === 'cover'
			? Math.max(width / sourceWidth, height / sourceHeight)
			: Math.min(width / sourceWidth, height / sourceHeight);
	const w = sourceWidth * scale;
	const h = sourceHeight * scale;
	return { x: (width - w) / 2, y: (height - h) / 2, w, h };
};

export class PreviewPlayer {
	private readonly ctx: CanvasRenderingContext2D;
	private readonly slots: [Slot, Slot];
	private composition: PreviewComposition | null = null;
	private key = '';
	private offsets: number[] = [];
	private duration = 0;
	private active = 0;
	private index = 0;
	private playing = false;
	private muted = false;
	private frame = 0;
	private lastState = 0;
	/** Wall clock that drives segments whose file the browser cannot play. */
	private fallbackClock: { startedAt: number; offset: number } | null = null;
	private pausedOffset = 0;
	/** True while the canvas shows a real video frame that can stand in during a load. */
	private hasFrame = false;
	private showSafeArea = false;
	private backdrop: BlurredBackdrop | null = null;
	private readonly gpsMaps = new Map<string, GpsMiniMap>();
	private readonly urls = new Map<File, string>();

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly onState: (state: PreviewState) => void,
	) {
		const ctx = canvas.getContext('2d', { alpha: false });
		if (!ctx) throw new Error('Could not create a 2D rendering context.');
		this.ctx = ctx;
		const makeSlot = (): Slot => {
			const video = document.createElement('video');
			video.preload = 'auto';
			video.playsInline = true;
			// A frame that arrives while paused (a seek) is drawn as soon as it is decodable. The
			// redraw waits a frame so the slot's own bookkeeping for this event has settled first.
			const redraw = () => {
				requestAnimationFrame(() => {
					if (!this.playing) this.draw();
				});
			};
			for (const event of ['seeked', 'loadeddata', 'canplay']) video.addEventListener(event, redraw);
			return { video, segment: -1, ready: Promise.resolve(false), ok: null, token: 0 };
		};
		this.slots = [makeSlot(), makeSlot()];
		this.draw();
	}

	get isPlaying(): boolean {
		return this.playing;
	}

	/**
	 * Swaps in a new composition. Style-only changes (title, transitions, framing) take effect
	 * immediately without interrupting playback; a different clip sequence rewinds to the start.
	 */
	setComposition(composition: PreviewComposition | null): void {
		const key = composition
			? `${composition.width}x${composition.height}|` +
				composition.segments.map((segment) => `${segment.id}:${segment.start.toFixed(3)}:${segment.seconds.toFixed(3)}`).join('|')
			: '';
		const sizeChanged =
			!this.composition ||
			!composition ||
			this.composition.width !== composition.width ||
			this.composition.height !== composition.height;
		this.composition = composition;
		this.gpsMaps.clear();

		if (sizeChanged && composition) {
			// Resizing clears the canvas, so there is no previous picture left to hold on to.
			this.canvas.width = composition.width;
			this.canvas.height = composition.height;
			this.hasFrame = false;
		}
		this.backdrop =
			composition?.blurredBackdrop ? new BlurredBackdrop(composition.width, composition.height) : null;

		if (key !== this.key) {
			this.key = key;
			this.offsets = [];
			let total = 0;
			for (const segment of composition?.segments ?? []) {
				this.offsets.push(total);
				total += segment.seconds;
			}
			this.duration = total;
			this.pause();
			this.releaseUnusedUrls();
			this.seek(0);
		} else {
			this.draw();
			this.emitState(true);
		}
	}

	toggle(): void {
		if (this.playing) this.pause();
		else this.play();
	}

	play(): void {
		const segments = this.composition?.segments ?? [];
		if (this.playing || segments.length === 0) return;
		if (this.currentTime() >= this.duration - 0.05) this.seek(0);
		this.playing = true;
		void this.startActive();
		this.loop();
		this.emitState(true);
	}

	pause(): void {
		if (!this.playing) return;
		this.pausedOffset = this.localTime();
		this.playing = false;
		this.fallbackClock = null;
		cancelAnimationFrame(this.frame);
		for (const slot of this.slots) slot.video.pause();
		this.draw();
		this.emitState(true);
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		for (const slot of this.slots) slot.video.muted = muted;
		this.emitState(true);
	}

	/** Shows where a social app draws its own interface over the video. */
	setShowSafeArea(show: boolean): void {
		this.showSafeArea = show;
		this.hasFrame = false;
		this.draw();
	}

	next(): void {
		const segments = this.composition?.segments ?? [];
		if (this.index + 1 < segments.length) this.seek(this.offsets[this.index + 1]);
	}

	previous(): void {
		// Like a music player: jump to the start of this clip first, then to the one before it.
		const target = this.localTime() > 0.6 || this.index === 0 ? this.index : this.index - 1;
		if (this.offsets.length > 0) this.seek(this.offsets[target]);
	}

	/** Jumps to `time` seconds on the output timeline, keeping the play/pause state. */
	seek(time: number): void {
		const segments = this.composition?.segments ?? [];
		if (segments.length === 0) {
			this.index = 0;
			this.pausedOffset = 0;
			for (const slot of this.slots) this.unload(slot);
			this.draw();
			this.emitState(true);
			return;
		}
		const clamped = Math.max(0, Math.min(time, this.duration - 0.001));
		let index = 0;
		while (index + 1 < segments.length && this.offsets[index + 1] <= clamped) index++;
		const offset = Math.max(0, clamped - this.offsets[index]);

		const wasPlaying = this.playing;
		for (const slot of this.slots) slot.video.pause();
		this.index = index;
		this.pausedOffset = offset;
		this.fallbackClock = null;

		const slot = this.slots[this.active];
		this.load(slot, index, offset);
		this.preloadNext();
		if (wasPlaying) void this.startActive();
		else void slot.ready.then(() => this.draw());
		this.draw();
		this.emitState(true);
	}

	dispose(): void {
		this.pause();
		for (const slot of this.slots) this.unload(slot);
		for (const url of this.urls.values()) URL.revokeObjectURL(url);
		this.urls.clear();
	}

	// -------------------------------------------------------------------------

	private urlFor(file: File): string {
		let url = this.urls.get(file);
		if (!url) {
			url = URL.createObjectURL(file);
			this.urls.set(file, url);
		}
		return url;
	}

	private releaseUnusedUrls(): void {
		const used = new Set((this.composition?.segments ?? []).map((segment) => segment.file));
		for (const [file, url] of this.urls) {
			if (used.has(file)) continue;
			for (const slot of this.slots) {
				if (slot.video.src === url) this.unload(slot);
			}
			URL.revokeObjectURL(url);
			this.urls.delete(file);
		}
	}

	private unload(slot: Slot): void {
		slot.token++;
		slot.segment = -1;
		slot.ok = null;
		slot.ready = Promise.resolve(false);
		slot.video.pause();
		slot.video.removeAttribute('src');
		slot.video.load();
	}

	/** Points `slot` at `offset` seconds into segment `index`. */
	private load(slot: Slot, index: number, offset: number): void {
		const segment = this.composition?.segments[index];
		if (!segment) {
			this.unload(slot);
			return;
		}
		const token = ++slot.token;
		slot.segment = index;
		slot.ok = null;
		const video = slot.video;
		video.muted = this.muted;
		const url = this.urlFor(segment.file);
		slot.ready = (async () => {
			if (video.src !== url) {
				video.src = url;
				if (!(await waitFor(video, 'loadedmetadata', LOAD_TIMEOUT_MS))) return false;
			} else if (video.readyState < 1 && !(await waitFor(video, 'loadedmetadata', LOAD_TIMEOUT_MS))) {
				return false;
			}
			if (token !== slot.token) return false;
			video.currentTime = segment.start + offset;
			return waitFor(video, 'seeked', LOAD_TIMEOUT_MS);
		})().then((ok) => {
			if (token === slot.token) slot.ok = ok && !video.error;
			return token === slot.token && ok && !video.error;
		});
	}

	private preloadNext(): void {
		const standby = this.slots[1 - this.active];
		const next = this.index + 1;
		if (next < (this.composition?.segments.length ?? 0)) {
			if (standby.segment !== next) this.load(standby, next, 0);
		} else {
			this.unload(standby);
		}
	}

	private async startActive(): Promise<void> {
		const slot = this.slots[this.active];
		const index = this.index;
		const ok = await slot.ready;
		if (!this.playing || this.index !== index || this.slots[this.active] !== slot) return;
		if (!ok) {
			// The browser cannot play this file; keep the timeline moving so the rest still previews.
			this.fallbackClock = { startedAt: performance.now(), offset: this.pausedOffset };
			return;
		}
		try {
			await slot.video.play();
		} catch (error) {
			if ((error as DOMException)?.name === 'NotAllowedError' && !this.muted) {
				this.setMuted(true);
				await slot.video.play().catch(() => undefined);
			}
		}
	}

	private localTime(): number {
		const segment = this.composition?.segments[this.index];
		if (!segment) return 0;
		if (this.fallbackClock) {
			return this.fallbackClock.offset + (performance.now() - this.fallbackClock.startedAt) / 1000;
		}
		const slot = this.slots[this.active];
		if (slot.segment !== this.index || slot.ok !== true) return this.pausedOffset;
		return Math.max(0, slot.video.currentTime - segment.start);
	}

	private currentTime(): number {
		return (this.offsets[this.index] ?? 0) + Math.min(this.localTime(), this.composition?.segments[this.index]?.seconds ?? 0);
	}

	private advance(): void {
		const segments = this.composition?.segments ?? [];
		const outgoing = this.slots[this.active];
		outgoing.video.pause();
		this.fallbackClock = null;
		if (this.index + 1 >= segments.length) {
			// The reel has ended: rewind so the next play starts from the top.
			this.playing = false;
			cancelAnimationFrame(this.frame);
			this.active = 0;
			this.index = 0;
			this.pausedOffset = 0;
			this.load(this.slots[0], 0, 0);
			this.preloadNext();
			void this.slots[0].ready.then(() => this.draw());
			this.emitState(true);
			return;
		}
		this.index++;
		this.pausedOffset = 0;
		this.active = 1 - this.active;
		const incoming = this.slots[this.active];
		if (incoming.segment !== this.index) this.load(incoming, this.index, 0);
		void this.startActive();
		this.preloadNext();
		this.emitState(true);
	}

	private loop = (): void => {
		if (!this.playing) return;
		const segment = this.composition?.segments[this.index];
		if (segment) {
			const slot = this.slots[this.active];
			const local = this.localTime();
			const ended = slot.ok === true && slot.video.ended;
			if (local >= segment.seconds - 0.001 || ended) this.advance();
		}
		this.draw();
		this.emitState(false);
		if (this.playing) this.frame = requestAnimationFrame(this.loop);
	};

	private emitState(force: boolean): void {
		const now = performance.now();
		if (!force && now - this.lastState < STATE_INTERVAL_MS) return;
		this.lastState = now;
		const segments = this.composition?.segments ?? [];
		this.onState({
			playing: this.playing,
			time: segments.length > 0 ? this.currentTime() : 0,
			duration: this.duration,
			index: segments.length > 0 ? this.index : -1,
			count: segments.length,
			name: segments[this.index]?.name ?? '',
			muted: this.muted,
		});
	}

	private gpsMapFor(segment: PreviewSegment): GpsMiniMap | null {
		if (!segment.gps || !this.composition) return null;
		let map = this.gpsMaps.get(segment.id);
		if (!map) {
			map = new GpsMiniMap(segment.gps, this.composition.width, this.composition.height);
			this.gpsMaps.set(segment.id, map);
		}
		return map;
	}

	private drawMessage(lines: string[]): void {
		const { ctx, canvas } = this;
		const size = Math.max(12, Math.round(Math.min(canvas.width, canvas.height) * 0.045));
		ctx.save();
		ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
		ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		lines.forEach((line, index) => {
			ctx.fillText(line, canvas.width / 2, canvas.height / 2 + (index - (lines.length - 1) / 2) * size * 1.4, canvas.width * 0.9);
		});
		ctx.restore();
	}

	private draw(): void {
		const { ctx } = this;
		const composition = this.composition;
		const width = this.canvas.width;
		const height = this.canvas.height;

		const segment = composition?.segments[this.index];
		if (!composition || !segment) {
			ctx.fillStyle = '#000000';
			ctx.fillRect(0, 0, width, height);
			this.hasFrame = false;
			this.drawMessage(['No clips to preview yet']);
			return;
		}

		const local = Math.min(this.localTime(), segment.seconds);
		const effect = effectAt(segment.transitions, local, PREVIEW_FRAME_SECONDS, segment.seconds, segment.seed);
		const slot = this.slots[this.active];
		const video = slot.video;
		// Only a finished seek guarantees the element shows this segment; mid-load it may still hold
		// the previous clip's picture.
		const drawable =
			slot.segment === this.index && slot.ok === true && !video.seeking && video.readyState >= 2 && video.videoWidth > 0;
		if (!drawable && slot.ok !== false && this.hasFrame) {
			// Keep the last good picture on screen until the new one is ready, instead of flashing.
			return;
		}

		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, width, height);
		this.hasFrame = drawable;

		if (drawable) {
			drawWithEffect(ctx, width, height, effect, () => {
				this.backdrop?.draw(ctx, width, height, (backdrop, w, h) => {
					const rect = fittedRect(video.videoWidth, video.videoHeight, w, h, 'cover');
					backdrop.drawImage(video, rect.x, rect.y, rect.w, rect.h);
				});
				const rect = fittedRect(video.videoWidth, video.videoHeight, width, height, composition.fit);
				ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
			});
			applyEffectOverlay(ctx, this.canvas, width, height, effect);
		} else if (slot.ok === false) {
			this.drawMessage([`${segment.name}`, 'cannot be previewed in this browser', '(it is still included in the output)']);
		} else {
			this.drawMessage([`Loading ${segment.name}…`]);
		}

		if (composition.title) {
			// Paused (e.g. the poster frame at 0 s) the title is shown fully rather than mid pop-in.
			const intro = segment.titleIntro && this.playing ? local : null;
			drawTitle(ctx, composition.title.canvas, composition.title.x, composition.title.y, intro);
		}
		this.gpsMapFor(segment)?.draw(ctx, local);
		if (this.showSafeArea && composition.safeArea) this.drawSafeArea(composition.safeArea);
	}

	/** Shades the bands an app covers and outlines the area that stays visible. */
	private drawSafeArea(safe: SafeArea): void {
		const { ctx } = this;
		const width = this.canvas.width;
		const height = this.canvas.height;
		const top = Math.round(height * safe.top);
		const bottom = Math.round(height * (1 - safe.bottom));
		const left = Math.round(width * safe.left);
		const right = Math.round(width * (1 - safe.right));
		const vertical = height > width;
		ctx.save();
		ctx.fillStyle = 'rgba(255, 40, 100, 0.22)';
		ctx.fillRect(0, 0, width, top);
		ctx.fillRect(0, bottom, width, height - bottom);
		ctx.fillRect(0, top, left, bottom - top);
		ctx.fillRect(right, top, width - right, bottom - top);
		ctx.setLineDash([8, 6]);
		ctx.lineWidth = 2;
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
		ctx.strokeRect(left + 1, top + 1, right - left - 2, bottom - top - 2);
		ctx.setLineDash([]);

		const size = Math.max(10, Math.round(Math.min(width, height) * 0.032));
		ctx.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(vertical ? 'App header · tabs' : 'Title bar', width / 2, top / 2, width * 0.9);
		ctx.fillText(
			vertical ? 'Username · caption · music' : 'Progress bar · controls',
			width / 2,
			(bottom + height) / 2,
			width * 0.9,
		);
		if (vertical) {
			// The like / comment / share column of TikTok, Reels and Shorts.
			const radius = Math.round((width - right) * 0.28);
			const centerX = Math.round((right + width) / 2);
			for (let index = 0; index < 4; index++) {
				ctx.beginPath();
				ctx.arc(centerX, Math.round(height * 0.5) + index * radius * 3, radius, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		ctx.restore();
	}
}

export const formatPreviewTime = (seconds: number): string =>
	seconds < 60 ? `${seconds.toFixed(1)}s` : formatDuration(seconds);
