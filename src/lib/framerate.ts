import type { FrameRateSetting } from '../types';

/** Hard ceiling for the automatic mode, also used when no source rate could be detected. */
export const AUTO_MAX_FRAME_RATE = 120;

/** Rates that real footage actually uses; measured values are snapped onto them. */
const STANDARD_FRAME_RATES = [
	23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 144, 240,
];

/** Measured packet rates are noisy, so anything within this margin counts as a standard rate. */
const SNAP_TOLERANCE = 0.02;

/**
 * Turns a measured source rate into a usable frame rate, or null when nothing sensible was
 * detected. Snapping matters: a source measured at 29.94 fps would otherwise produce a frame
 * interval slightly longer than the real one, which drops roughly every 500th frame.
 */
export const normalizeSourceFrameRate = (rate: number | null | undefined): number | null => {
	if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;

	let snapped: number | null = null;
	let bestDistance = Infinity;
	for (const candidate of STANDARD_FRAME_RATES) {
		const distance = Math.abs(rate - candidate) / candidate;
		// Ties go to the higher candidate, which never costs frames.
		if (distance <= SNAP_TOLERANCE && distance <= bestDistance) {
			snapped = candidate;
			bestDistance = distance;
		}
	}

	return snapped ?? Math.min(rate, AUTO_MAX_FRAME_RATE);
};

/**
 * Resolves the frame rate cap for a merge. In `auto` mode the fastest source clip wins so that no
 * clip loses frames, limited to {@link AUTO_MAX_FRAME_RATE}; when no clip reported a usable rate
 * that same limit is used as the fallback.
 */
export const resolveFrameRate = (
	setting: FrameRateSetting,
	sourceRates: readonly (number | null | undefined)[] = [],
): number => {
	if (setting !== 'auto') {
		const explicit = Number(setting);
		return Number.isFinite(explicit) && explicit > 0 ? explicit : AUTO_MAX_FRAME_RATE;
	}

	let best: number | null = null;
	for (const rate of sourceRates) {
		const normalized = normalizeSourceFrameRate(rate);
		if (normalized !== null && (best === null || normalized > best)) best = normalized;
	}

	return best === null ? AUTO_MAX_FRAME_RATE : Math.min(best, AUTO_MAX_FRAME_RATE);
};

export const formatFrameRate = (rate: number): string =>
	`${Number.isInteger(rate) ? rate : rate.toFixed(2)} fps`;
