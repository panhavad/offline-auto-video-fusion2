import type { ClipSegment, HighlightPick, ResolutionPreset } from '../types';

export const DEFAULT_HIGHLIGHT_CLIP_SECONDS = 2;
export const DEFAULT_HIGHLIGHT_MAX_SECONDS = 30;
export const HIGHLIGHT_CLIP_SECONDS_RANGE = { min: 0.5, max: 10 } as const;
export const HIGHLIGHT_MAX_SECONDS_RANGE = { min: 5, max: 180 } as const;
/** Social platforms re-encode anything above 1080p, so larger sources are scaled down to it. */
export const HIGHLIGHT_MAX_SHORT_EDGE = 1080;

export interface HighlightPlan {
	segments: ClipSegment[];
	/** Length of the finished reel in seconds. */
	totalSeconds: number;
	/** Longest segment actually used; below the requested length when the clips had to share. */
	secondsPerClip: number;
	/** True when segments were shortened so that every clip fits inside the length limit. */
	shortened: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Cuts one segment out of every clip so the whole reel stays within `maxSeconds`. Every clip is
 * always represented: with more clips than fit at `clipSeconds`, each segment is shortened instead
 * of dropping clips, and time a short clip cannot fill is shared out among the longer ones.
 */
export function planHighlight(
	durations: number[],
	clipSeconds: number,
	maxSeconds: number,
	pick: HighlightPick,
): HighlightPlan {
	const count = durations.length;
	const lengths = new Array<number>(count).fill(0);
	if (count === 0) return { segments: [], totalSeconds: 0, secondsPerClip: 0, shortened: false };

	// Water-filling: the shortest clips are served first, so whatever they cannot use is spread
	// evenly over the clips that are long enough to take it.
	const order = durations
		.map((duration, index) => ({ index, duration: Number.isFinite(duration) ? Math.max(0, duration) : 0 }))
		.sort((a, b) => a.duration - b.duration);
	let budget = Math.max(0, maxSeconds);
	let remaining = count;
	for (const { index, duration } of order) {
		const share = Math.min(clipSeconds, budget / remaining);
		lengths[index] = Math.min(share, duration);
		budget -= lengths[index];
		remaining--;
	}

	const segments = lengths.map((seconds, index) => {
		const spare = Math.max(0, (Number.isFinite(durations[index]) ? durations[index] : 0) - seconds);
		// The very first and last moments of a recording are usually the least interesting
		// (pressing record, lowering the camera), so "middle" is the default pick.
		const start = pick === 'start' ? 0 : pick === 'end' ? spare : spare / 2;
		return { start: clamp(start, 0, spare), seconds };
	});

	const secondsPerClip = Math.max(...lengths);
	const fullLength = durations.filter((duration) => duration >= clipSeconds).length;
	return {
		segments,
		totalSeconds: lengths.reduce((sum, seconds) => sum + seconds, 0),
		secondsPerClip,
		shortened: fullLength > 0 && lengths.some((seconds, index) => seconds < clipSeconds - 1e-6 && durations[index] >= clipSeconds),
	};
}

/**
 * Highlights follow the first clip's level of detail like a merge does, but never exceed 1080p:
 * that is what TikTok, Reels and Shorts publish at, and anything larger only costs encode time.
 */
export const highlightResolution = (
	resolution: ResolutionPreset,
	sourceWidth: number,
	sourceHeight: number,
): ResolutionPreset => {
	if (resolution !== 'auto') return resolution;
	const shortEdge = Math.min(sourceWidth, sourceHeight);
	return Number.isFinite(shortEdge) && shortEdge > HIGHLIGHT_MAX_SHORT_EDGE ? '1080' : 'auto';
};
