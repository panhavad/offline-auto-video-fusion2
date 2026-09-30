/**
 * Matching video clips to a timestamped GPS track.
 *
 * A clip's recording time rarely lands exactly on a GPS fix: loggers sample every few seconds (or
 * minutes when saving battery), recording often starts a little before the logger does, and camera
 * clocks are sometimes set to the wrong time zone. The track is therefore sampled with a nearest-
 * neighbour search (binary search on the sorted timestamps) and positions between two fixes are
 * linearly interpolated. Times just outside the track snap to its nearest end when they fall within
 * the tolerance, so several clips may legitimately share (almost) the same point.
 */

import type { GeoPoint, GpsPoint, RecordedLocation } from '../types';

export const DEFAULT_GPS_MATCH_TOLERANCE_MINUTES = 15;
export const GPS_MATCH_TOLERANCE_OPTIONS = [0, 1, 5, 15, 30, 60, 180];

/** A clip's own location and the track position agree when they are this close. */
const LOCATION_AGREEMENT_METRES = 300;
/** How far from the route a clip may have been filmed and still be pinned to it by location. */
const LOCATION_FALLBACK_METRES = 500;
/** Embedded locations less accurate than this are ignored. */
const MAX_LOCATION_ACCURACY_METRES = 200;
/** Candidate clock corrections: every 15 minutes (time zones) up to ±14 hours. */
const OFFSET_STEP_MS = 15 * 60_000;
const MAX_OFFSET_MS = 14 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Interpolating across a GPS gap longer than this is reported as less precise. */
export const LONG_GPS_GAP_MS = 5 * 60_000;
const EARTH_RADIUS_METRES = 6_371_008.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in metres. */
export const distanceMetres = (a: GeoPoint, b: GeoPoint): number => {
	const deltaLatitude = radians(b.latitude - a.latitude);
	const deltaLongitude = radians(b.longitude - a.longitude);
	const h =
		Math.sin(deltaLatitude / 2) ** 2 +
		Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
	return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const isTimedTrack = (points: GpsPoint[]): boolean =>
	points.length > 0 && points[0].timestamp !== null && points[points.length - 1].timestamp !== null;

export interface TrackSample extends GeoPoint {
	elevation: number | null;
	/** Metres per second, or null when it cannot be known. */
	speed: number | null;
	/** The requested time. */
	timestamp: number;
	/** The sample lies `ratio` of the way from `points[lowerIndex]` to `points[upperIndex]`. */
	lowerIndex: number;
	upperIndex: number;
	ratio: number;
	/** `interpolated` inside the track; `nearest` when snapped to an end of the track. */
	method: 'interpolated' | 'nearest';
	/** Time between the requested time and the closest real GPS fix. */
	fixDistanceMs: number;
	/** Length of the gap between the two fixes that were interpolated (0 when snapped). */
	gapMs: number;
}

/** Index of the first point whose timestamp is at or after `time` (points must be sorted). */
const lowerBound = (points: GpsPoint[], time: number): number => {
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (points[middle].timestamp! < time) low = middle + 1;
		else high = middle;
	}
	return low;
};

const lerp = (a: number, b: number, ratio: number) => a + (b - a) * ratio;

const segmentSpeed = (a: GpsPoint, b: GpsPoint): number | null => {
	const seconds = ((b.timestamp ?? 0) - (a.timestamp ?? 0)) / 1000;
	return seconds > 0 ? distanceMetres(a, b) / seconds : null;
};

const buildSample = (
	points: GpsPoint[],
	lowerIndex: number,
	upperIndex: number,
	ratio: number,
	time: number,
	method: TrackSample['method'],
	fixDistanceMs: number,
): TrackSample => {
	const a = points[lowerIndex];
	const b = points[upperIndex];
	let speed: number | null;
	if (method === 'nearest') {
		// Outside the track nothing says how fast the camera moved; only a logged speed is kept.
		speed = (ratio < 0.5 ? a : b).speed;
	} else if (a.speed !== null && b.speed !== null) {
		speed = lerp(a.speed, b.speed, ratio);
	} else {
		speed = a.speed ?? b.speed ?? segmentSpeed(a, b);
	}
	return {
		latitude: lerp(a.latitude, b.latitude, ratio),
		longitude: lerp(a.longitude, b.longitude, ratio),
		elevation: a.elevation !== null && b.elevation !== null
			? lerp(a.elevation, b.elevation, ratio)
			: a.elevation ?? b.elevation,
		speed,
		timestamp: time,
		lowerIndex,
		upperIndex,
		ratio,
		method,
		fixDistanceMs,
		gapMs: method === 'nearest' ? 0 : (b.timestamp ?? 0) - (a.timestamp ?? 0),
	};
};

/**
 * Position on a timed track at `time`. Between two fixes the position is interpolated; before the
 * first or after the last fix it snaps to that fix when it is no more than `toleranceMs` away.
 * Returns null for untimed tracks and for times beyond the tolerance.
 */
export const sampleTrackAt = (points: GpsPoint[], time: number, toleranceMs: number): TrackSample | null => {
	if (points.length < 2 || !Number.isFinite(time) || !isTimedTrack(points)) return null;
	const lastIndex = points.length - 1;
	const first = points[0].timestamp!;
	const last = points[lastIndex].timestamp!;
	const tolerance = Math.max(0, toleranceMs);

	if (time <= first) {
		const distance = first - time;
		if (distance > tolerance) return null;
		return buildSample(points, 0, 1, 0, time, distance === 0 ? 'interpolated' : 'nearest', distance);
	}
	if (time >= last) {
		const distance = time - last;
		if (distance > tolerance) return null;
		return buildSample(points, lastIndex - 1, lastIndex, 1, time, distance === 0 ? 'interpolated' : 'nearest', distance);
	}

	const upper = Math.min(lastIndex, Math.max(1, lowerBound(points, time)));
	const lower = upper - 1;
	const before = points[lower].timestamp!;
	const after = points[upper].timestamp!;
	const ratio = after > before ? (time - before) / (after - before) : 0;
	return buildSample(points, lower, upper, ratio, time, 'interpolated', Math.min(time - before, after - time));
};

export interface TrackLocationMatch {
	/** Interpolated track time at the point of the route closest to the location. */
	timestamp: number;
	distanceMetres: number;
}

/**
 * Spatial nearest-neighbour search: projects `location` onto every route segment and returns the
 * closest pass within `radiusMetres`. Routes that go through the same place more than once (out and
 * back, loops) yield one candidate per pass; the pass nearest to `preferredTime` wins.
 */
export const locateOnTrack = (
	points: GpsPoint[],
	location: GeoPoint,
	radiusMetres: number,
	preferredTime: number | null,
): TrackLocationMatch | null => {
	if (points.length < 2 || !isTimedTrack(points)) return null;
	const metresPerDegreeLatitude = (Math.PI * EARTH_RADIUS_METRES) / 180;
	const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos(radians(location.latitude));
	const project = (point: GeoPoint) => ({
		x: (point.longitude - location.longitude) * metresPerDegreeLongitude,
		y: (point.latitude - location.latitude) * metresPerDegreeLatitude,
	});

	const passes: TrackLocationMatch[] = [];
	let current: TrackLocationMatch | null = null;
	let previous = project(points[0]);
	for (let index = 1; index < points.length; index++) {
		const next = project(points[index]);
		const dx = next.x - previous.x;
		const dy = next.y - previous.y;
		const lengthSquared = dx * dx + dy * dy;
		const ratio = lengthSquared > 0
			? Math.min(1, Math.max(0, -(previous.x * dx + previous.y * dy) / lengthSquared))
			: 0;
		const distance = Math.hypot(previous.x + dx * ratio, previous.y + dy * ratio);
		if (distance <= radiusMetres) {
			const timestamp = lerp(points[index - 1].timestamp!, points[index].timestamp!, ratio);
			if (!current || distance < current.distanceMetres) current = { timestamp, distanceMetres: distance };
		} else if (current) {
			passes.push(current);
			current = null;
		}
		previous = next;
	}
	if (current) passes.push(current);
	if (passes.length === 0) return null;

	const score = (pass: TrackLocationMatch) =>
		preferredTime === null ? pass.distanceMetres : Math.abs(pass.timestamp - preferredTime);
	return passes.reduce((best, pass) => (score(pass) < score(best) ? pass : best));
};

export interface GpsClipInput {
	id: string;
	/** Wall-clock recording start of the clip, or null when unknown. */
	recordedAt: number | null;
	durationMs: number;
	/** Location embedded in the video by the camera, when there is one. */
	location: RecordedLocation | null;
}

/**
 * - `time`: matched by recording time inside the track (interpolated).
 * - `nearest`: recorded just before/after the track, snapped to its nearest end within the tolerance.
 * - `location`: matched through the clip's embedded location because the time did not fit.
 * - `track-start`: no recording time at all; the map starts at the beginning of the track.
 * - `none`: nothing matched; the mini map is hidden for this clip.
 */
export type GpsClipMatchMethod = 'time' | 'nearest' | 'location' | 'track-start' | 'none';

export interface GpsClipMatch {
	id: string;
	method: GpsClipMatchMethod;
	/** Point on the GPS timeline that the clip's first frame corresponds to. */
	trackStartTime: number | null;
	/** Tolerance to use when sampling this clip's frames. */
	toleranceMs: number;
	/** Time between the clip's first mapped frame and the closest real GPS fix. */
	fixDistanceMs: number | null;
	/** Longest GPS gap interpolated across at the clip's first mapped frame. */
	gapMs: number;
	/** Distance between the clip's embedded location and the matched track position. */
	locationErrorMetres: number | null;
	/** For `location` matches: how far the time-only match would have been from the clip's location. */
	timeMatchErrorMetres: number | null;
}

export interface GpsMatchPlan {
	/** Correction added to every clip's recording time (non-zero when a clock/time-zone error was found). */
	clockOffsetMs: number;
	/** What justified the correction, or null when none was applied. */
	offsetEvidence: 'location' | 'time' | null;
	toleranceMs: number;
	matches: Map<string, GpsClipMatch>;
	matchedCount: number;
}

const usableLocation = (location: RecordedLocation | null): location is RecordedLocation =>
	location !== null &&
	Number.isFinite(location.latitude) &&
	Number.isFinite(location.longitude) &&
	(location.accuracy === null || location.accuracy <= MAX_LOCATION_ACCURACY_METRES);

/** First frame of a clip starting at `start` that can show a map, sampled; null when none can. */
const timeMatch = (points: GpsPoint[], start: number, durationMs: number, toleranceMs: number): TrackSample | null => {
	const first = points[0].timestamp! - toleranceMs;
	const last = points[points.length - 1].timestamp! + toleranceMs;
	const end = start + Math.max(0, durationMs);
	if (end < first || start > last) return null;
	return sampleTrackAt(points, Math.min(Math.max(start, first), last), toleranceMs);
};

interface OffsetScore {
	/** Clips whose recording time falls on the track. */
	timed: number;
	/** Located clips whose time-matched position agrees with where the camera said it was. */
	located: number;
}

const scoreOffset = (points: GpsPoint[], clips: GpsClipInput[], offset: number, toleranceMs: number): OffsetScore => {
	const score: OffsetScore = { timed: 0, located: 0 };
	for (const clip of clips) {
		if (clip.recordedAt === null) continue;
		const sample = timeMatch(points, clip.recordedAt + offset, clip.durationMs, toleranceMs);
		if (!sample) continue;
		score.timed++;
		if (usableLocation(clip.location) && distanceMetres(sample, clip.location) <= LOCATION_AGREEMENT_METRES) {
			score.located++;
		}
	}
	return score;
};

/** Smaller is more plausible: no correction, then whole-hour time-zone shifts, then the smallest shift. */
const offsetPreference = (offset: number) => (offset % HOUR_MS === 0 ? 0 : MAX_OFFSET_MS * 2) + Math.abs(offset);

/**
 * Detects a camera clock (or GPS file) that is off by a time-zone step. With embedded locations
 * the shift must make clearly more clips agree with the route than no shift does; without them a
 * shift is only considered when no clip matches the track at all.
 */
const detectClockOffset = (
	points: GpsPoint[],
	clips: GpsClipInput[],
	toleranceMs: number,
): { offset: number; evidence: GpsMatchPlan['offsetEvidence'] } => {
	const dated = clips.filter((clip) => clip.recordedAt !== null);
	if (dated.length === 0) return { offset: 0, evidence: null };
	const locatedCount = dated.filter((clip) => usableLocation(clip.location)).length;
	const zero = scoreOffset(points, dated, 0, toleranceMs);
	if (zero.timed === dated.length && (locatedCount === 0 || zero.located * 2 >= locatedCount)) {
		return { offset: 0, evidence: null };
	}

	let best = zero;
	let bestOffset = 0;
	for (let offset = -MAX_OFFSET_MS; offset <= MAX_OFFSET_MS; offset += OFFSET_STEP_MS) {
		if (offset === 0) continue;
		const score = scoreOffset(points, dated, offset, toleranceMs);
		const better =
			score.located > best.located ||
			(score.located === best.located && score.timed > best.timed) ||
			(score.located === best.located && score.timed === best.timed &&
				offsetPreference(offset) < offsetPreference(bestOffset));
		if (better) {
			best = score;
			bestOffset = offset;
		}
	}
	if (bestOffset === 0) return { offset: 0, evidence: null };

	const majority = Math.ceil(locatedCount / 2);
	if (locatedCount > 0) {
		if (zero.located < majority && best.located >= majority && best.located > zero.located) {
			return { offset: bestOffset, evidence: 'location' };
		}
		return { offset: 0, evidence: null };
	}
	if (zero.timed === 0 && best.timed > 0) return { offset: bestOffset, evidence: 'time' };
	return { offset: 0, evidence: null };
};

/**
 * Decides, for every clip, where on the GPS timeline its first frame belongs. The recording time
 * is the primary key; the clip's embedded location (when the camera wrote one) is used to detect
 * clock errors and to rescue clips whose time does not fit the track.
 */
export const planGpsMatches = (
	points: GpsPoint[],
	clips: GpsClipInput[],
	toleranceMinutes: number,
): GpsMatchPlan => {
	const toleranceMs = Math.max(0, toleranceMinutes) * 60_000;
	const matches = new Map<string, GpsClipMatch>();
	if (!isTimedTrack(points) || points.length < 2) {
		return { clockOffsetMs: 0, offsetEvidence: null, toleranceMs, matches, matchedCount: 0 };
	}

	const { offset, evidence } = detectClockOffset(points, clips, toleranceMs);
	let matchedCount = 0;
	for (const clip of clips) {
		const location = usableLocation(clip.location) ? clip.location : null;
		const start = clip.recordedAt === null ? null : clip.recordedAt + offset;
		const sample = start === null ? null : timeMatch(points, start, clip.durationMs, toleranceMs);
		const timeError = sample && location ? distanceMetres(sample, location) : null;

		// The camera's own GPS fix outranks a time match that lands somewhere else, e.g. a clip
		// snapped to the end of the track or interpolated across a long logging gap.
		const byLocation = location && (!sample || (timeError !== null && timeError > LOCATION_AGREEMENT_METRES))
			? locateOnTrack(points, location, LOCATION_FALLBACK_METRES, start)
			: null;

		let match: GpsClipMatch;
		if (byLocation && (timeError === null || byLocation.distanceMetres < timeError)) {
			match = {
				id: clip.id,
				method: 'location',
				trackStartTime: byLocation.timestamp,
				// The anchor lies on the track; the tolerance only has to cover the clip running past its end.
				toleranceMs: Math.max(toleranceMs, clip.durationMs),
				fixDistanceMs: null,
				gapMs: 0,
				locationErrorMetres: byLocation.distanceMetres,
				timeMatchErrorMetres: timeError,
			};
		} else if (sample && start !== null) {
			match = {
				id: clip.id,
				method: sample.method === 'nearest' ? 'nearest' : 'time',
				trackStartTime: start,
				toleranceMs,
				fixDistanceMs: sample.fixDistanceMs,
				gapMs: sample.gapMs,
				locationErrorMetres: timeError,
				timeMatchErrorMetres: null,
			};
		} else if (start === null) {
			match = {
				id: clip.id,
				method: 'track-start',
				trackStartTime: points[0].timestamp,
				toleranceMs,
				fixDistanceMs: null,
				gapMs: 0,
				locationErrorMetres: null,
				timeMatchErrorMetres: null,
			};
		} else {
			match = {
				id: clip.id,
				method: 'none',
				trackStartTime: start,
				toleranceMs,
				fixDistanceMs: null,
				gapMs: 0,
				locationErrorMetres: null,
				timeMatchErrorMetres: null,
			};
		}
		if (match.method !== 'none') matchedCount++;
		matches.set(clip.id, match);
	}
	return { clockOffsetMs: offset, offsetEvidence: evidence, toleranceMs, matches, matchedCount };
};

/** "+9 h", "-5 h 30 min" */
export const formatOffset = (offsetMs: number): string => {
	const sign = offsetMs < 0 ? '-' : '+';
	const minutes = Math.round(Math.abs(offsetMs) / 60_000);
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return `${sign}${hours > 0 ? `${hours} h` : ''}${hours > 0 && rest > 0 ? ' ' : ''}${rest > 0 || hours === 0 ? `${rest} min` : ''}`;
};

/** "12 s", "4 min", "1 h 5 min" */
export const formatSpan = (milliseconds: number): string => {
	const seconds = Math.round(Math.abs(milliseconds) / 1000);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h${minutes % 60 > 0 ? ` ${minutes % 60} min` : ''}`;
};
