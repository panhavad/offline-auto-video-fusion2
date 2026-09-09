import type { AspectRatioSetting, FitMode, ResolutionPreset } from '../types';

/** Used when the first clip cannot be read, so the pipeline still has a sane frame to encode. */
export const FALLBACK_SOURCE_WIDTH = 1920;
export const FALLBACK_SOURCE_HEIGHT = 1080;

/** Aspect ratios this far apart are treated as identical, so rounding never triggers a crop. */
const ASPECT_TOLERANCE = 0.01;

export interface OutputSize {
	width: number;
	height: number;
}

/** Encoders reject odd dimensions, so every computed edge is rounded to an even number. */
export const evenEdge = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

export const ASPECT_RATIO_SETTINGS: AspectRatioSetting[] = [
	'auto',
	'16:9',
	'9:16',
	'4:3',
	'3:4',
	'1:1',
	'4:5',
	'21:9',
];

/** Returns the requested width ÷ height, or null when the frame should follow the first clip. */
export const parseAspectRatio = (setting: AspectRatioSetting): number | null => {
	if (setting === 'auto') return null;
	const [width, height] = setting.split(':').map(Number);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return width / height;
};

/**
 * The output frame follows the first clip by default: `auto` on both controls reproduces its exact
 * size. An aspect ratio replaces the shape, a resolution preset replaces the size, and each one can
 * be set independently — when only the ratio is forced, the first clip's short edge is kept so the
 * level of detail stays the same.
 */
export const resolveOutputSize = (
	resolution: ResolutionPreset,
	aspectRatio: AspectRatioSetting,
	sourceWidth: number,
	sourceHeight: number,
): OutputSize => {
	const width = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : FALLBACK_SOURCE_WIDTH;
	const height = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : FALLBACK_SOURCE_HEIGHT;
	const forcedAspect = parseAspectRatio(aspectRatio);

	// Following the clip on both axes is reproduced exactly rather than recomputed, so that a
	// rounding error can never nudge the output away from the size it is supposed to match.
	if (resolution === 'auto' && forcedAspect === null) return { width: evenEdge(width), height: evenEdge(height) };

	const sourceShortEdge = Math.min(width, height);
	const requested = resolution === 'auto' ? sourceShortEdge : Number(resolution);
	const shortEdge = Number.isFinite(requested) && requested > 0 ? requested : sourceShortEdge;
	const aspect = forcedAspect ?? width / height;

	return aspect >= 1
		? { width: evenEdge(shortEdge * aspect), height: evenEdge(shortEdge) }
		: { width: evenEdge(shortEdge), height: evenEdge(shortEdge / aspect) };
};

/**
 * A forced frame crops whatever does not fit it; when both controls follow the first clip the
 * configured letterboxing is kept for the clips that have a different shape.
 */
export const resolveFitMode = (
	resolution: ResolutionPreset,
	aspectRatio: AspectRatioSetting,
	fit: FitMode,
): FitMode => (resolution === 'auto' && aspectRatio === 'auto' ? fit : 'cover');

/** True when the clip has a different shape than the output frame and therefore loses edges. */
export const isCropped = (clipWidth: number, clipHeight: number, output: OutputSize): boolean => {
	if (!(clipWidth > 0) || !(clipHeight > 0) || !(output.width > 0) || !(output.height > 0)) return false;
	const outputAspect = output.width / output.height;
	return Math.abs(clipWidth / clipHeight - outputAspect) / outputAspect > ASPECT_TOLERANCE;
};

export const formatSize = (size: OutputSize): string => `${size.width}×${size.height}`;
