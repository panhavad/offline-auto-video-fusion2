import type { GeoPoint, GpsPoint, GpsTrack } from '../types';

const LATITUDE_KEYS = ['latitude', 'lat'];
const LONGITUDE_KEYS = ['longitude', 'lon', 'lng', 'long'];
const TIME_KEYS = ['timestamp', 'time', 'datetime', 'date', 'utc', 'gpstime', 'gpstimestamp'];
const ELEVATION_KEYS = ['elevation', 'altitude', 'ele', 'alt'];
const SPEED_KEYS = ['speed', 'velocity'];

const finite = (value: unknown): number | null => {
	const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
	return Number.isFinite(number) ? number : null;
};

const timestamp = (value: unknown): number | null => {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value < 10_000_000_000 ? value * 1000 : value;
	}
	const numeric = Number(value);
	if (Number.isFinite(numeric) && String(value).trim() !== '') {
		return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
	}
	const parsed = Date.parse(String(value));
	return Number.isNaN(parsed) ? null : parsed;
};

const validPoint = (point: GpsPoint): boolean =>
	Number.isFinite(point.latitude) &&
	Number.isFinite(point.longitude) &&
	point.latitude >= -90 &&
	point.latitude <= 90 &&
	point.longitude >= -180 &&
	point.longitude <= 180;

const cleanTrack = (name: string, points: GpsPoint[]): GpsTrack => {
	const valid = points.filter(validPoint);
	if (valid.length < 2) throw new Error('The GPS file must contain at least two valid coordinates.');
	const timed = valid.filter((point) => point.timestamp !== null);
	if (timed.length > 0 && timed.length !== valid.length) {
		throw new Error('Every GPS point must have a timestamp when any point has one.');
	}
	if (timed.length === valid.length) valid.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	return { name, points: valid };
};

const parseXml = (fileName: string, text: string): GpsTrack => {
	const document_ = new DOMParser().parseFromString(text, 'application/xml');
	if (document_.querySelector('parsererror')) throw new Error('The GPS XML file is not valid.');

	const nodes = Array.from(document_.querySelectorAll('trkpt, rtept, wpt'));
	if (nodes.length > 0) {
		return cleanTrack(
			fileName,
			nodes.map((node) => ({
				latitude: finite(node.getAttribute('lat')) ?? Number.NaN,
				longitude: finite(node.getAttribute('lon')) ?? Number.NaN,
				timestamp: timestamp(node.querySelector('time')?.textContent),
				elevation: finite(node.querySelector('ele')?.textContent),
				speed: finite(node.querySelector('speed')?.textContent),
			})),
		);
	}

	const trackCoordinates = Array.from(document_.getElementsByTagNameNS('*', 'coord'));
	if (trackCoordinates.length > 0) {
		const times = Array.from(document_.getElementsByTagNameNS('*', 'when'));
		return cleanTrack(
			fileName,
			trackCoordinates.map((node, index) => {
				const [longitude, latitude, elevation] = (node.textContent ?? '').trim().split(/\s+/);
				return {
					latitude: finite(latitude) ?? Number.NaN,
					longitude: finite(longitude) ?? Number.NaN,
					timestamp: timestamp(times[index]?.textContent),
					elevation: finite(elevation),
					speed: null,
				};
			}),
		);
	}

	const coordinates = Array.from(document_.querySelectorAll('coordinates'))
		.flatMap((node) => (node.textContent ?? '').trim().split(/\s+/))
		.map((coordinate): GpsPoint => {
			const [longitude, latitude, elevation] = coordinate.split(',');
			return {
				latitude: finite(latitude) ?? Number.NaN,
				longitude: finite(longitude) ?? Number.NaN,
				timestamp: null,
				elevation: finite(elevation),
				speed: null,
			};
		});
	return cleanTrack(fileName, coordinates);
};

type JsonRecord = Record<string, unknown>;

const parseGeoJson = (fileName: string, value: unknown): GpsTrack => {
	if (!value || typeof value !== 'object') throw new Error('The GeoJSON file is not valid.');
	const root = value as JsonRecord;
	const features = root.type === 'FeatureCollection' && Array.isArray(root.features)
		? root.features
		: [root];
	const points: GpsPoint[] = [];

	for (const candidate of features) {
		if (!candidate || typeof candidate !== 'object') continue;
		const feature = candidate as JsonRecord;
		const geometry = (feature.type === 'Feature' ? feature.geometry : feature) as JsonRecord | undefined;
		if (!geometry || !Array.isArray(geometry.coordinates)) continue;
		const properties = (feature.properties ?? {}) as JsonRecord;
		const times = (properties.coordTimes ?? properties.times ?? properties.timestamps) as unknown[] | undefined;

		if (geometry.type === 'LineString') {
			geometry.coordinates.forEach((coordinate, index) => {
				if (!Array.isArray(coordinate)) return;
				points.push({
					longitude: finite(coordinate[0]) ?? Number.NaN,
					latitude: finite(coordinate[1]) ?? Number.NaN,
					elevation: finite(coordinate[2]),
					timestamp: timestamp(times?.[index]),
					speed: null,
				});
			});
		} else if (geometry.type === 'Point') {
			const coordinate = geometry.coordinates;
			points.push({
				longitude: finite(coordinate[0]) ?? Number.NaN,
				latitude: finite(coordinate[1]) ?? Number.NaN,
				elevation: finite(coordinate[2]),
				timestamp: timestamp(properties.time ?? properties.timestamp),
				speed: finite(properties.speed),
			});
		}
	}
	return cleanTrack(fileName, points);
};

const splitCsvLine = (line: string): string[] => {
	const values: string[] = [];
	let value = '';
	let quoted = false;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (character === '"') {
			if (quoted && line[index + 1] === '"') {
				value += '"';
				index++;
			} else {
				quoted = !quoted;
			}
		} else if (character === ',' && !quoted) {
			values.push(value.trim());
			value = '';
		} else {
			value += character;
		}
	}
	values.push(value.trim());
	return values;
};

const keyIndex = (headers: string[], keys: string[]): number =>
	headers.findIndex((header) => keys.includes(header.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z]/g, '')));

const parseCsv = (fileName: string, text: string): GpsTrack => {
	const lines = text.split(/\r?\n/).filter((line) => line.trim());
	if (lines.length < 3) throw new Error('The CSV file must contain a header and at least two points.');
	const headers = splitCsvLine(lines[0]);
	const latitude = keyIndex(headers, LATITUDE_KEYS);
	const longitude = keyIndex(headers, LONGITUDE_KEYS);
	if (latitude < 0 || longitude < 0) throw new Error('The CSV needs latitude and longitude columns.');
	const time = keyIndex(headers, TIME_KEYS);
	const elevation = keyIndex(headers, ELEVATION_KEYS);
	const speed = keyIndex(headers, SPEED_KEYS);

	return cleanTrack(
		fileName,
		lines.slice(1).map((line) => {
			const values = splitCsvLine(line);
			return {
				latitude: finite(values[latitude]) ?? Number.NaN,
				longitude: finite(values[longitude]) ?? Number.NaN,
				timestamp: time >= 0 ? timestamp(values[time]) : null,
				elevation: elevation >= 0 ? finite(values[elevation]) : null,
				speed: speed >= 0 ? finite(values[speed]) : null,
			};
		}),
	);
};

export const parseGpsFile = async (file: File): Promise<GpsTrack> => {
	const text = await file.text();
	const lowerName = file.name.toLowerCase();
	if (lowerName.endsWith('.gpx') || lowerName.endsWith('.kml') || text.trimStart().startsWith('<')) {
		return parseXml(file.name, text);
	}
	if (lowerName.endsWith('.json') || lowerName.endsWith('.geojson') || text.trimStart().startsWith('{')) {
		return parseGeoJson(file.name, JSON.parse(text));
	}
	return parseCsv(file.name, text);
};

/** Parses ISO 6709 values commonly stored in QuickTime location metadata. */
export const parseIso6709 = (value: string): GeoPoint | null => {
	const match = value.trim().match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
	if (!match) return null;
	const latitude = Number(match[1]);
	const longitude = Number(match[2]);
	return validPoint({ latitude, longitude, timestamp: null, elevation: null, speed: null })
		? { latitude, longitude }
		: null;
};

export const locationFromMetadata = (raw: Record<string, unknown> | undefined): GeoPoint | null => {
	if (!raw) return null;
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== 'string' || !/(location|iso6709|gps)/i.test(key)) continue;
		const parsed = parseIso6709(value);
		if (parsed) return parsed;
	}
	return null;
};
