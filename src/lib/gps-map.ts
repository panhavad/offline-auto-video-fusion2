import type { GeoPoint, GpsInfoItem, GpsMapBackground, GpsMapPosition, GpsPoint } from '../types';

export interface GpsOverlayInput {
	points: GpsPoint[];
	clipCreatedAt: number | null;
	clipLocation: GeoPoint | null;
	clipDuration: number;
	position: GpsMapPosition;
	size: number;
	background: GpsMapBackground;
	opacity: number;
	rotation: number;
	informationOrder: GpsInfoItem[];
	showSpeed: boolean;
	showAltitude: boolean;
	showDistance: boolean;
	showCoordinates: boolean;
	showDateTime: boolean;
}

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const distanceSquared = (a: GeoPoint, b: GeoPoint): number => {
	const latitudeScale = Math.cos(((a.latitude + b.latitude) * Math.PI) / 360);
	const x = (a.longitude - b.longitude) * latitudeScale;
	const y = a.latitude - b.latitude;
	return x * x + y * y;
};

const distanceMetres = (a: GeoPoint, b: GeoPoint): number => {
	const latitudeScale = Math.cos(((a.latitude + b.latitude) * Math.PI) / 360);
	const x = (b.longitude - a.longitude) * latitudeScale;
	const y = b.latitude - a.latitude;
	return Math.hypot(x, y) * 111_320;
};

interface PositionedGpsPoint extends GpsPoint {
	x: number;
	y: number;
	distance: number;
}

interface AltitudeGraph {
	left: number;
	right: number;
	top: number;
	bottom: number;
	min: number;
	max: number;
	totalDistance: number;
}

export class GpsMiniMap {
	private readonly points: PositionedGpsPoint[];
	private readonly startTime: number | null;
	private readonly width: number;
	private readonly height: number;
	private readonly x: number;
	private readonly y: number;
	private readonly padding: number;
	private readonly base: OffscreenCanvas;
	private readonly altitudeGraph: AltitudeGraph | null;
	private readonly informationRows = new Map<Exclude<GpsInfoItem, 'altitude'>, number>();

	constructor(
		private readonly input: GpsOverlayInput,
		frameWidth: number,
		frameHeight: number,
	) {
		const hasAltitudeGraph = input.showAltitude && input.points.some((point) => point.elevation !== null);
		const activeInformation = input.informationOrder.filter((item) => {
			if (item === 'altitude') return hasAltitudeGraph;
			if (item === 'date-time') return input.showDateTime && input.clipCreatedAt !== null;
			if (item === 'distance') return input.showDistance;
			if (item === 'speed') return input.showSpeed;
			return input.showCoordinates;
		});
		const informationRatio = activeInformation.reduce(
			(total, item) => total + (item === 'altitude' ? 0.28 : 0.08),
			0.055,
		);
		const heightRatio = 0.6 + informationRatio;
		const margin = Math.round(Math.min(frameWidth, frameHeight) * 0.035);
		const desiredWidth = frameWidth * input.size / 100;
		this.width = Math.round(Math.min(desiredWidth, (frameHeight - margin * 2) / heightRatio));
		this.height = Math.round(this.width * heightRatio);
		this.padding = Math.max(8, Math.round(this.width * 0.055));
		this.x = input.position.endsWith('right') ? frameWidth - this.width - margin : margin;
		this.y = input.position.startsWith('bottom') ? frameHeight - this.height - margin : margin;

		const minLatitude = Math.min(...input.points.map((point) => point.latitude));
		const maxLatitude = Math.max(...input.points.map((point) => point.latitude));
		const meanLatitude = (minLatitude + maxLatitude) / 2;
		const longitudeScale = Math.max(0.01, Math.cos((meanLatitude * Math.PI) / 180));
		const unrotated = input.points.map((point) => ({
			point,
			x: point.longitude * longitudeScale,
			y: -point.latitude,
		}));
		const centerX = (Math.min(...unrotated.map((point) => point.x)) + Math.max(...unrotated.map((point) => point.x))) / 2;
		const centerY = (Math.min(...unrotated.map((point) => point.y)) + Math.max(...unrotated.map((point) => point.y))) / 2;
		const radians = (input.rotation * Math.PI) / 180;
		const cosine = Math.cos(radians);
		const sine = Math.sin(radians);
		const projected = unrotated.map(({ point, x, y }) => {
			const centeredX = x - centerX;
			const centeredY = y - centerY;
			return {
				point,
				x: centeredX * cosine - centeredY * sine,
				y: centeredX * sine + centeredY * cosine,
			};
		});
		const minX = Math.min(...projected.map((point) => point.x));
		const maxX = Math.max(...projected.map((point) => point.x));
		const minY = Math.min(...projected.map((point) => point.y));
		const maxY = Math.max(...projected.map((point) => point.y));
		const mapTop = this.padding;
		const mapBottom = Math.round(this.width * 0.6);
		const mapWidth = this.width - this.padding * 2;
		const mapHeight = Math.max(1, mapBottom - mapTop);
		const scale = Math.min(mapWidth / Math.max(maxX - minX, 1e-8), mapHeight / Math.max(maxY - minY, 1e-8));
		const offsetX = this.padding + (mapWidth - (maxX - minX) * scale) / 2;
		const offsetY = mapTop + (mapHeight - (maxY - minY) * scale) / 2;
		let cumulativeDistance = 0;
		this.points = projected.map(({ point, x, y }, index) => {
			if (index > 0) cumulativeDistance += distanceMetres(input.points[index - 1], point);
			return {
				...point,
				x: offsetX + (x - minX) * scale,
				y: offsetY + (y - minY) * scale,
				distance: cumulativeDistance,
			};
		});
		const elevations = this.points
			.map((point) => point.elevation)
			.filter((elevation): elevation is number => elevation !== null);
		let informationTop = mapBottom;
		let altitudeGraph: AltitudeGraph | null = null;
		for (const item of activeInformation) {
			if (item === 'altitude') {
				const graphHeight = Math.round(this.width * 0.28);
				altitudeGraph = {
					left: this.padding,
					right: this.width - this.padding,
					top: informationTop + this.padding * 0.55,
					bottom: informationTop + graphHeight - this.padding * 0.45,
					min: Math.min(...elevations),
					max: Math.max(...elevations),
					totalDistance: cumulativeDistance,
				};
				informationTop += graphHeight;
			} else {
				const rowHeight = Math.round(this.width * 0.08);
				this.informationRows.set(item, informationTop + rowHeight - this.padding * 0.16);
				informationTop += rowHeight;
			}
		}
		this.altitudeGraph = altitudeGraph;
		this.base = new OffscreenCanvas(this.width, this.height);
		const baseContext = this.base.getContext('2d');
		if (!baseContext) throw new Error('Could not create the GPS mini map.');
		const radius = Math.round(this.width * 0.06);
		baseContext.fillStyle = 'rgba(10, 18, 16, 0.92)';
		baseContext.beginPath();
		baseContext.roundRect(0, 0, this.width, this.height, radius);
		baseContext.fill();
		if (input.background === 'map') {
			baseContext.save();
			baseContext.beginPath();
			baseContext.roundRect(0, 0, this.width, mapBottom + this.padding * 0.45, [radius, radius, 0, 0]);
			baseContext.clip();
			baseContext.fillStyle = '#d9ded5';
			baseContext.fillRect(0, 0, this.width, mapBottom + this.padding);

			baseContext.fillStyle = '#c5d9d5';
			baseContext.beginPath();
			baseContext.ellipse(
				this.width * 0.15,
				mapTop + mapHeight * 0.32,
				this.width * 0.2,
				mapHeight * 0.18,
				radians * 0.4,
				0,
				Math.PI * 2,
			);
			baseContext.fill();

			baseContext.save();
			baseContext.translate(this.width / 2, mapTop + mapHeight / 2);
			baseContext.rotate(radians);
			const block = this.width * 0.12;
			baseContext.fillStyle = 'rgba(187, 198, 184, 0.58)';
			for (let row = -4; row <= 4; row++) {
				for (let column = -5; column <= 5; column++) {
					if ((row * 7 + column * 3) % 5 === 0) continue;
					const inset = this.width * 0.012;
					baseContext.fillRect(
						column * block + inset,
						row * block + inset,
						block - inset * 2,
						block - inset * 2,
					);
				}
			}
			baseContext.strokeStyle = 'rgba(255, 255, 255, 0.8)';
			baseContext.lineWidth = Math.max(1, this.width * 0.014);
			for (let offset = -6; offset <= 6; offset++) {
				baseContext.beginPath();
				baseContext.moveTo(-this.width, offset * block);
				baseContext.lineTo(this.width, offset * block);
				baseContext.stroke();
				baseContext.beginPath();
				baseContext.moveTo(offset * block, -this.height);
				baseContext.lineTo(offset * block, this.height);
				baseContext.stroke();
			}
			baseContext.strokeStyle = '#f8f5e9';
			baseContext.lineWidth = Math.max(3, this.width * 0.035);
			baseContext.beginPath();
			baseContext.moveTo(-this.width, mapHeight * 0.22);
			baseContext.bezierCurveTo(
				-this.width * 0.3,
				-mapHeight * 0.38,
				this.width * 0.25,
				mapHeight * 0.45,
				this.width,
				-mapHeight * 0.22,
			);
			baseContext.stroke();
			baseContext.strokeStyle = '#d3aa71';
			baseContext.lineWidth = Math.max(1, this.width * 0.009);
			baseContext.stroke();
			baseContext.restore();
			baseContext.restore();
		}

		baseContext.lineCap = 'round';
		baseContext.lineJoin = 'round';
		baseContext.strokeStyle = input.background === 'map'
			? 'rgba(25, 52, 44, 0.5)'
			: 'rgba(255, 255, 255, 0.38)';
		baseContext.lineWidth = Math.max(3, this.width * 0.018);
		baseContext.beginPath();
		this.points.forEach((point, index) => index === 0
			? baseContext.moveTo(point.x, point.y)
			: baseContext.lineTo(point.x, point.y));
		baseContext.stroke();

		if (this.altitudeGraph) {
			const graph = this.altitudeGraph;
			baseContext.fillStyle = 'rgba(18, 31, 26, 0.98)';
			baseContext.fillRect(0, graph.top - this.padding * 0.35, this.width, graph.bottom - graph.top + this.padding * 0.7);
			baseContext.strokeStyle = 'rgba(255, 255, 255, 0.1)';
			baseContext.lineWidth = 1;
			for (let line = 0; line <= 2; line++) {
				const y = graph.top + ((graph.bottom - graph.top) * line) / 2;
				baseContext.beginPath();
				baseContext.moveTo(graph.left, y);
				baseContext.lineTo(graph.right, y);
				baseContext.stroke();
			}
			baseContext.strokeStyle = '#8ad5ac';
			baseContext.lineWidth = Math.max(2, this.width * 0.01);
			baseContext.beginPath();
			let drawing = false;
			this.points.forEach((point, index) => {
				if (point.elevation === null) {
					drawing = false;
					return;
				}
				const x = this.altitudeX(point.distance, index);
				const y = this.altitudeY(point.elevation);
				if (drawing) baseContext.lineTo(x, y);
				else baseContext.moveTo(x, y);
				drawing = true;
			});
			baseContext.stroke();
			const labelSize = Math.max(8, Math.round(this.width * 0.035));
			baseContext.font = `600 ${labelSize}px "Segoe UI", system-ui, sans-serif`;
			baseContext.textBaseline = 'top';
			baseContext.textAlign = 'left';
			baseContext.fillStyle = 'rgba(255, 255, 255, 0.62)';
			baseContext.fillText('ALTITUDE', graph.left, graph.top);
			baseContext.textAlign = 'right';
			baseContext.fillText(`${Math.round(graph.max)} m`, graph.right, graph.top);
			baseContext.fillText(`${Math.round(graph.min)} m`, graph.right, graph.bottom - labelSize);
		}

		const compassX = this.width - this.padding * 1.35;
		const compassY = this.padding * 1.35;
		const compassRadius = Math.max(7, this.width * 0.045);
		baseContext.fillStyle = 'rgba(255, 255, 255, 0.88)';
		baseContext.beginPath();
		baseContext.arc(compassX, compassY, compassRadius, 0, Math.PI * 2);
		baseContext.fill();
		baseContext.save();
		baseContext.translate(compassX, compassY);
		baseContext.rotate(radians);
		baseContext.fillStyle = '#d84f4f';
		baseContext.beginPath();
		baseContext.moveTo(0, -compassRadius * 0.72);
		baseContext.lineTo(compassRadius * 0.3, compassRadius * 0.35);
		baseContext.lineTo(0, compassRadius * 0.18);
		baseContext.lineTo(-compassRadius * 0.3, compassRadius * 0.35);
		baseContext.closePath();
		baseContext.fill();
		baseContext.restore();
		baseContext.fillStyle = '#24352f';
		baseContext.font = `700 ${Math.max(7, Math.round(this.width * 0.032))}px "Segoe UI", system-ui, sans-serif`;
		baseContext.textAlign = 'center';
		baseContext.textBaseline = 'bottom';
		baseContext.fillText('N', compassX, compassY - compassRadius * 0.72);

		const firstTimestamp = input.points[0].timestamp;
		if (firstTimestamp === null) {
			this.startTime = null;
		} else if (input.clipCreatedAt !== null) {
			this.startTime = input.clipCreatedAt;
		} else if (input.clipLocation) {
			let nearest = input.points[0];
			let nearestDistance = distanceSquared(input.clipLocation, nearest);
			for (const point of input.points.slice(1)) {
				const distance = distanceSquared(input.clipLocation, point);
				if (distance < nearestDistance) {
					nearest = point;
					nearestDistance = distance;
				}
			}
			this.startTime = nearest.timestamp;
		} else {
			this.startTime = firstTimestamp;
		}
	}

	private altitudeX(distance: number, pointIndex: number): number {
		const graph = this.altitudeGraph;
		if (!graph) return 0;
		const ratio = graph.totalDistance > 0
			? distance / graph.totalDistance
			: pointIndex / Math.max(1, this.points.length - 1);
		return graph.left + (graph.right - graph.left) * Math.min(1, Math.max(0, ratio));
	}

	private altitudeY(elevation: number): number {
		const graph = this.altitudeGraph;
		if (!graph) return 0;
		const range = Math.max(1, graph.max - graph.min);
		const ratio = (elevation - graph.min) / range;
		return graph.bottom - (graph.bottom - graph.top) * ratio;
	}

	private pointAt(seconds: number): { point: PositionedGpsPoint; speed: number | null; upperIndex: number } | null {
		const timed = this.startTime !== null;
		const target = timed
			? this.startTime! + seconds * 1000
			: Math.min(1, seconds / Math.max(this.input.clipDuration, 0.001)) * (this.points.length - 1);
		const first = timed ? this.points[0].timestamp! : 0;
		const last = timed ? this.points[this.points.length - 1].timestamp! : this.points.length - 1;
		if (target < first || target > last) return null;

		let low = 1;
		let high = this.points.length - 1;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((timed ? this.points[middle].timestamp! : middle) < target) low = middle + 1;
			else high = middle;
		}
		const upper = low;
		const before = this.points[Math.max(0, upper - 1)];
		const after = this.points[Math.min(upper, this.points.length - 1)];
		const beforeValue = timed ? before.timestamp! : upper - 1;
		const afterValue = timed ? after.timestamp! : upper;
		const ratio = afterValue === beforeValue ? 0 : (target - beforeValue) / (afterValue - beforeValue);
		const interpolate = (a: number, b: number) => a + (b - a) * ratio;
		let speed = before.speed ?? after.speed;
		if (speed === null && timed && after.timestamp! > before.timestamp!) {
			speed = distanceMetres(before, after) / ((after.timestamp! - before.timestamp!) / 1000);
		}
		return {
			point: {
				latitude: interpolate(before.latitude, after.latitude),
				longitude: interpolate(before.longitude, after.longitude),
				elevation: before.elevation === null || after.elevation === null
					? before.elevation ?? after.elevation
					: interpolate(before.elevation, after.elevation),
				speed,
				timestamp: timed ? target : null,
				x: interpolate(before.x, after.x),
				y: interpolate(before.y, after.y),
				distance: interpolate(before.distance, after.distance),
			},
			speed,
			upperIndex: upper,
		};
	}

	draw(context: DrawingContext, seconds: number): boolean {
		const current = this.pointAt(seconds);
		if (!current) return false;
		context.save();
		context.globalAlpha *= this.input.opacity / 100;
		context.translate(this.x, this.y);
		context.drawImage(this.base, 0, 0);
		context.lineCap = 'round';
		context.lineJoin = 'round';
		context.strokeStyle = '#178b5e';
		context.lineWidth = Math.max(3, this.width * 0.022);
		context.beginPath();
		context.moveTo(this.points[0].x, this.points[0].y);
		for (const point of this.points.slice(1, current.upperIndex)) context.lineTo(point.x, point.y);
		context.lineTo(current.point.x, current.point.y);
		context.stroke();

		const markerRadius = Math.max(4, this.width * 0.032);
		context.fillStyle = '#ffffff';
		context.beginPath();
		context.arc(current.point.x, current.point.y, markerRadius * 1.7, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = '#e75d5d';
		context.beginPath();
		context.arc(current.point.x, current.point.y, markerRadius, 0, Math.PI * 2);
		context.fill();

		if (this.altitudeGraph && current.point.elevation !== null) {
			const graph = this.altitudeGraph;
			const x = this.altitudeX(current.point.distance, current.upperIndex);
			const y = this.altitudeY(current.point.elevation);
			context.strokeStyle = 'rgba(255, 255, 255, 0.65)';
			context.lineWidth = Math.max(1, this.width * 0.006);
			context.beginPath();
			context.moveTo(x, graph.top);
			context.lineTo(x, graph.bottom);
			context.stroke();
			context.fillStyle = '#ffffff';
			context.beginPath();
			context.arc(x, y, Math.max(3, this.width * 0.018), 0, Math.PI * 2);
			context.fill();
			context.fillStyle = '#e75d5d';
			context.beginPath();
			context.arc(x, y, Math.max(2, this.width * 0.01), 0, Math.PI * 2);
			context.fill();
			const altitudeFont = Math.max(9, Math.round(this.width * 0.043));
			context.font = `700 ${altitudeFont}px "Segoe UI", system-ui, sans-serif`;
			context.textBaseline = 'top';
			context.textAlign = 'left';
			context.fillStyle = '#ffffff';
			context.fillText(
				`${Math.round(current.point.elevation)} m now`,
				graph.left,
				graph.top + altitudeFont * 1.05,
				graph.right - graph.left,
			);
		}

		if (this.informationRows.size > 0) {
			const fontSize = Math.max(10, Math.round(this.width * 0.052));
			context.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
			context.textBaseline = 'bottom';
			context.textAlign = 'left';
			context.fillStyle = '#ffffff';
			for (const item of this.input.informationOrder) {
				if (item === 'altitude') continue;
				const y = this.informationRows.get(item);
				if (y === undefined) continue;
				let label: string | null = null;
				if (item === 'distance') {
					label = current.point.distance < 1000
						? `${Math.round(current.point.distance)} m`
						: `${(current.point.distance / 1000).toFixed(2)} km`;
				} else if (item === 'speed' && current.speed !== null) {
					label = `${Math.round(current.speed * 3.6)} km/h`;
				} else if (item === 'coordinates') {
					label = `${current.point.latitude.toFixed(5)}, ${current.point.longitude.toFixed(5)}`;
				} else if (item === 'date-time' && this.input.clipCreatedAt !== null) {
					const date = new Date(this.input.clipCreatedAt + seconds * 1000);
					const pad = (value: number) => String(value).padStart(2, '0');
					label =
						`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
						`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
				}
				if (label) context.fillText(label, this.padding, y, this.width - this.padding * 2);
			}
		}
		context.restore();
		return true;
	}
}
