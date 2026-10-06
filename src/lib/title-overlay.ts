import type { MergeSettings, TextStyle } from '../types';
import type { SafeArea } from './safe-area';

export interface TitleOverlay {
	canvas: OffscreenCanvas;
	x: number;
	y: number;
}

type TitleSettings = Pick<MergeSettings, 'title' | 'titlePosition' | 'titleColor' | 'titleScale' | 'titleShadow'> & {
	textStyle?: TextStyle;
};

export const TEXT_STYLE_LABELS: Record<TextStyle, string> = {
	classic: 'Classic',
	bold: 'Bold outline (TikTok)',
	caption: 'Caption box',
	neon: 'Neon glow',
	meme: 'Meme (Impact)',
	pop: 'Pop 3D',
};

interface StyleSpec {
	weight: number;
	family: string;
	uppercase: boolean;
	lineHeight: number;
	/** Outline width as a fraction of the font size; 0 for none. */
	stroke: number;
	strokeColor: string;
	/** Rounded box behind every line, as in the caption stickers of TikTok and Reels. */
	box: boolean;
	glow: boolean;
	/** Stacked offset copies that give the text a solid extruded edge. */
	depth: boolean;
	/** Lines are aligned to the side the title is anchored to; classic keeps them left-aligned. */
	alignToPosition: boolean;
}

const HEAVY_FAMILY = '"Arial Black", "Segoe UI Black", "Helvetica Neue", Arial, system-ui, sans-serif';
const UI_FAMILY = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

const BASE_STYLE: StyleSpec = {
	weight: 600,
	family: UI_FAMILY,
	uppercase: false,
	lineHeight: 1.25,
	stroke: 0,
	strokeColor: '#000000',
	box: false,
	glow: false,
	depth: false,
	alignToPosition: true,
};

const STYLES: Record<TextStyle, StyleSpec> = {
	classic: { ...BASE_STYLE, alignToPosition: false },
	bold: { ...BASE_STYLE, weight: 900, family: HEAVY_FAMILY, lineHeight: 1.15, stroke: 0.16 },
	caption: { ...BASE_STYLE, weight: 800, lineHeight: 1.45, box: true },
	neon: { ...BASE_STYLE, weight: 700, uppercase: true, lineHeight: 1.3, stroke: 0.035, strokeColor: '#FFFFFF', glow: true },
	meme: {
		...BASE_STYLE,
		weight: 400,
		family: 'Impact, "Anton", "Haettenschweiler", "Arial Narrow Bold", "Arial Black", sans-serif',
		uppercase: true,
		lineHeight: 1.1,
		stroke: 0.12,
	},
	pop: { ...BASE_STYLE, weight: 900, family: HEAVY_FAMILY, uppercase: true, lineHeight: 1.2, stroke: 0.06, strokeColor: '#111111', depth: true },
};

const parseHex = (color: string): [number, number, number] | null => {
	const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
	if (!match) return null;
	return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
};

/** Black or white, whichever reads better on `color`. */
const contrastingText = (color: string): string => {
	const rgb = parseHex(color);
	if (!rgb) return '#000000';
	const [r, g, b] = rgb.map((part) => part / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#000000' : '#FFFFFF';
};

/** A darker shade of `color`, used for the extruded edge of the pop style. */
const shade = (color: string, factor: number): string => {
	const rgb = parseHex(color);
	if (!rgb) return '#000000';
	const [r, g, b] = rgb.map((part) => Math.round(part * factor));
	return `rgb(${r}, ${g}, ${b})`;
};

const roundedRect = (
	context: OffscreenCanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
) => {
	const r = Math.min(radius, width / 2, height / 2);
	context.beginPath();
	context.moveTo(x + r, y);
	context.arcTo(x + width, y, x + width, y + height, r);
	context.arcTo(x + width, y + height, x, y + height, r);
	context.arcTo(x, y + height, x, y, r);
	context.arcTo(x, y, x + width, y, r);
	context.closePath();
};

/**
 * Rasterises the title once; the result is blitted onto every frame. Each {@link TextStyle} uses
 * only fonts that ship with the operating system, so the styles keep working offline. With a
 * `safeArea` the title keeps clear of the interface a social app draws over the video.
 */
export function renderTitleOverlay(
	settings: TitleSettings,
	width: number,
	height: number,
	safeArea: SafeArea | null = null,
): TitleOverlay | null {
	const text = settings.title.trim();
	if (!text) return null;

	const style = STYLES[settings.textStyle ?? 'classic'] ?? STYLES.classic;
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => (style.uppercase ? line.toUpperCase() : line));
	if (lines.length === 0) return null;

	const fontSize = Math.max(10, Math.round((height * settings.titleScale) / 100));
	const font = `${style.weight} ${fontSize}px ${style.family}`;
	const lineHeight = Math.round(fontSize * style.lineHeight);
	const blur = settings.titleShadow ? Math.round(fontSize * 0.3) : 0;
	const strokeWidth = style.stroke > 0 ? Math.max(1, Math.round(fontSize * style.stroke)) : 0;
	const glowBlur = style.glow ? Math.round(fontSize * 0.6) : 0;
	const depth = style.depth ? Math.max(2, Math.round(fontSize * 0.09)) : 0;
	const boxPadX = style.box ? Math.round(fontSize * 0.45) : 0;
	const pad = Math.max(blur * 2, glowBlur * 2, strokeWidth + blur, depth + blur) + boxPadX + 4;

	const measurer = new OffscreenCanvas(8, 8).getContext('2d');
	if (!measurer) return null;
	measurer.font = font;
	const lineWidths = lines.map((line) => Math.ceil(measurer.measureText(line).width));
	const textWidth = Math.max(...lineWidths);

	const canvas = new OffscreenCanvas(
		Math.max(1, textWidth + pad * 2 + depth),
		Math.max(1, lineHeight * lines.length + pad * 2 + depth),
	);
	const context = canvas.getContext('2d');
	if (!context) return null;

	const [vertical, horizontal] = settings.titlePosition.split('-');
	const align = style.alignToPosition ? horizontal : 'left';
	const lineX = (index: number) => {
		if (align === 'center') return pad + Math.round((textWidth - lineWidths[index]) / 2);
		if (align === 'right') return pad + textWidth - lineWidths[index];
		return pad;
	};

	context.font = font;
	context.textBaseline = 'top';
	context.textAlign = 'left';
	context.lineJoin = 'round';

	const applyShadow = () => {
		if (blur > 0) {
			context.shadowColor = 'rgba(0, 0, 0, 0.75)';
			context.shadowBlur = blur;
			context.shadowOffsetY = Math.round(fontSize * 0.05);
		}
	};
	const clearShadow = () => {
		context.shadowColor = 'transparent';
		context.shadowBlur = 0;
		context.shadowOffsetY = 0;
	};

	lines.forEach((line, index) => {
		const x = lineX(index);
		const y = pad + index * lineHeight;
		context.save();

		if (style.box) {
			applyShadow();
			context.fillStyle = settings.titleColor;
			const inset = Math.round(lineHeight * 0.04);
			roundedRect(context, x - boxPadX, y + inset, lineWidths[index] + boxPadX * 2, lineHeight - inset * 2, Math.round(fontSize * 0.3));
			context.fill();
			clearShadow();
			context.fillStyle = contrastingText(settings.titleColor);
			// "top" sits above the glyphs' optical centre, so the text is nudged into the box middle.
			context.fillText(line, x, y + Math.round((lineHeight - fontSize) / 2));
		} else if (style.glow) {
			context.shadowColor = settings.titleColor;
			context.fillStyle = settings.titleColor;
			for (const glow of [glowBlur, glowBlur / 2, glowBlur / 4]) {
				context.shadowBlur = glow;
				context.fillText(line, x, y);
			}
			clearShadow();
			context.lineWidth = strokeWidth;
			context.strokeStyle = style.strokeColor;
			context.strokeText(line, x, y);
			context.fillText(line, x, y);
		} else {
			applyShadow();
			context.lineWidth = strokeWidth * 2;
			context.strokeStyle = style.strokeColor;
			if (depth > 0) {
				context.fillStyle = shade(settings.titleColor, 0.35);
				for (let step = depth; step > 0; step--) {
					context.strokeText(line, x + step, y + step);
					context.fillText(line, x + step, y + step);
					clearShadow();
				}
			}
			if (strokeWidth > 0) {
				context.strokeText(line, x, y);
				clearShadow();
			}
			context.fillStyle = settings.titleColor;
			context.fillText(line, x, y);
		}

		context.restore();
	});

	const margin = Math.round(Math.min(width, height) * 0.04);
	const inset = (fraction: number | undefined, edge: number) =>
		safeArea && fraction !== undefined ? Math.max(margin, Math.round(edge * fraction)) : margin;
	const left = inset(safeArea?.left, width);
	const right = inset(safeArea?.right, width);
	const top = inset(safeArea?.top, height);
	const bottom = inset(safeArea?.bottom, height);
	let x = left - pad;
	if (horizontal === 'center') x = Math.round((width - canvas.width) / 2);
	else if (horizontal === 'right') x = width - canvas.width - right + pad;
	let y = top - pad;
	if (vertical === 'middle') y = Math.round((height - canvas.height) / 2);
	else if (vertical === 'bottom') y = height - canvas.height - bottom + pad;

	return { canvas, x, y };
}
