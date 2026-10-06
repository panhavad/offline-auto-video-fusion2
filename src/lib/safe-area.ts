import type { HighlightFormat, MergeSettings } from '../types';

/**
 * Part of the frame that social apps cover with their own interface, as fractions of the frame
 * edge. Overlays placed inside the remaining area stay visible on TikTok, Reels and Shorts.
 */
export interface SafeArea {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** An area to keep clear, as fractions of the frame (independent of the rendering size). */
export interface FrameRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const SAFE_AREAS: Record<HighlightFormat, SafeArea> = {
	// Vertical apps: status bar + "Following | For you" tabs on top, the like/comment/share column
	// on the right, and username, caption, music and the tab bar along the bottom.
	'9:16': { top: 0.14, right: 0.16, bottom: 0.24, left: 0.06 },
	// Landscape players: title bar on top and the progress bar + controls along the bottom.
	'16:9': { top: 0.07, right: 0.05, bottom: 0.13, left: 0.05 },
};

/** The safe area overlays respect, or null for a full merge, which is not made for an app feed. */
export const safeAreaFor = (settings: Pick<MergeSettings, 'outputMode' | 'highlightFormat'>): SafeArea | null =>
	settings.outputMode === 'highlight' ? SAFE_AREAS[settings.highlightFormat] : null;

export const overlayRect = (
	overlay: { canvas: { width: number; height: number }; x: number; y: number } | null,
	frameWidth: number,
	frameHeight: number,
): FrameRect | null =>
	overlay
		? {
				x: overlay.x / frameWidth,
				y: overlay.y / frameHeight,
				width: overlay.canvas.width / frameWidth,
				height: overlay.canvas.height / frameHeight,
			}
		: null;
