import type { MergeSettings } from '../types';

export interface TitleOverlay {
	canvas: OffscreenCanvas;
	x: number;
	y: number;
}

export function renderTitleOverlay(settings: MergeSettings, width: number, height: number): TitleOverlay | null {
	const text = settings.title.trim();
	if (!text) return null;

	const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return null;

	const fontSize = Math.max(10, Math.round((height * settings.titleScale) / 100));
	const font = `600 ${fontSize}px "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
	const lineHeight = Math.round(fontSize * 1.25);
	const blur = settings.titleShadow ? Math.round(fontSize * 0.3) : 0;
	const pad = blur * 2 + 4;

	const measurer = new OffscreenCanvas(8, 8).getContext('2d');
	if (!measurer) return null;
	measurer.font = font;
	const textWidth = Math.ceil(Math.max(...lines.map((line) => measurer.measureText(line).width)));

	const canvas = new OffscreenCanvas(
		Math.max(1, textWidth + pad * 2),
		Math.max(1, lineHeight * lines.length + pad * 2),
	);
	const context = canvas.getContext('2d');
	if (!context) return null;

	context.font = font;
	context.textBaseline = 'top';
	context.textAlign = 'left';
	if (blur > 0) {
		context.shadowColor = 'rgba(0, 0, 0, 0.75)';
		context.shadowBlur = blur;
		context.shadowOffsetY = Math.round(fontSize * 0.05);
	}
	context.fillStyle = settings.titleColor;
	lines.forEach((line, index) => {
		context.fillText(line, pad, pad + index * lineHeight);
	});

	const margin = Math.round(Math.min(width, height) * 0.04);
	const [vertical, horizontal] = settings.titlePosition.split('-');
	let x = margin - pad;
	if (horizontal === 'center') x = Math.round((width - canvas.width) / 2);
	else if (horizontal === 'right') x = width - canvas.width - margin + pad;
	let y = margin - pad;
	if (vertical === 'middle') y = Math.round((height - canvas.height) / 2);
	else if (vertical === 'bottom') y = height - canvas.height - margin + pad;

	return { canvas, x, y };
}
