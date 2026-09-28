/**
 * Recording-time discovery for source clips.
 *
 * Most cameras never write the tag formats a demuxer exposes as "metadata" (`©day`,
 * `com.apple.quicktime.creationdate`, Matroska `DateUTC`), which is why so many files look
 * undated. They do fill in the ISO-BMFF header clock instead - the `mvhd`/`tkhd` creation time
 * that Windows Explorer shows as "Media created" - so that header is read here directly and used
 * whenever the demuxer came back empty. File names that carry a timestamp (`VID_20240501_102233`
 * and friends) are the last resort before the file's modified time.
 */

/** Where a clip's recording time came from, in the order the sources are tried. */
export type CreationDateSource = 'metadata' | 'container' | 'filename' | 'modified';

/** Seconds between the ISO-BMFF/QuickTime epoch (1904-01-01 UTC) and the Unix epoch. */
const QUICKTIME_EPOCH_OFFSET_MS = 2_082_844_800_000;
/** Anything older than this is a placeholder or a broken clock, not a recording time. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);
/** Clocks run fast sometimes; a year of slack keeps those files usable. */
const FUTURE_TOLERANCE_MS = 366 * 24 * 60 * 60 * 1000;
/** How much closer to the modified time the local-clock reading must be before it is preferred. */
const LOCAL_CLOCK_MARGIN_MS = 10 * 60 * 1000;
/** Header bytes read per box: enough for a 64-bit box header or a version-1 `mvhd` prefix. */
const BOX_HEADER_BYTES = 16;
const MVHD_PREFIX_BYTES = 24;
/** Guard against pathological files: stop walking after this many boxes at one level. */
const MAX_BOXES_PER_LEVEL = 256;

export const isPlausibleDate = (milliseconds: number | null): milliseconds is number =>
	milliseconds !== null &&
	Number.isFinite(milliseconds) &&
	milliseconds >= EARLIEST_PLAUSIBLE_MS &&
	milliseconds <= Date.now() + FUTURE_TOLERANCE_MS;

interface BoxHeader {
	type: string;
	/** First byte of the box payload. */
	contentStart: number;
	/** First byte after the box. */
	end: number;
}

const readSlice = async (file: Blob, start: number, length: number): Promise<DataView | null> => {
	if (start < 0 || length <= 0 || start >= file.size) return null;
	const buffer = await file.slice(start, Math.min(file.size, start + length)).arrayBuffer();
	return buffer.byteLength > 0 ? new DataView(buffer) : null;
};

const boxType = (view: DataView, offset: number): string => {
	let type = '';
	for (let index = 0; index < 4; index++) type += String.fromCharCode(view.getUint8(offset + index));
	return type;
};

const readBoxHeader = async (file: Blob, offset: number, limit: number): Promise<BoxHeader | null> => {
	if (offset + 8 > limit) return null;
	const view = await readSlice(file, offset, BOX_HEADER_BYTES);
	if (!view || view.byteLength < 8) return null;

	let size = view.getUint32(0);
	const type = boxType(view, 4);
	let contentStart = offset + 8;
	if (size === 1) {
		// 64-bit size: the real length follows the type field.
		if (view.byteLength < 16) return null;
		size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
		contentStart = offset + 16;
	} else if (size === 0) {
		// A zero size means "runs to the end of the file".
		size = limit - offset;
	}

	const end = offset + size;
	if (contentStart > end || end > limit || !Number.isSafeInteger(end)) return null;
	return { type, contentStart, end };
};

/** Finds a direct child box by type inside `[start, limit)`. */
const findBox = async (file: Blob, start: number, limit: number, types: string[]): Promise<BoxHeader | null> => {
	let offset = start;
	for (let visited = 0; visited < MAX_BOXES_PER_LEVEL && offset < limit; visited++) {
		const header = await readBoxHeader(file, offset, limit);
		if (!header) return null;
		if (types.includes(header.type)) return header;
		if (header.end <= offset) return null;
		offset = header.end;
	}
	return null;
};

/** Reads the creation time out of an `mvhd` or `tkhd` payload; both share the same prefix layout. */
const readHeaderDate = async (file: Blob, box: BoxHeader): Promise<number | null> => {
	const view = await readSlice(file, box.contentStart, MVHD_PREFIX_BYTES);
	if (!view || view.byteLength < 8) return null;

	const version = view.getUint8(0);
	let seconds: number;
	if (version === 1) {
		if (view.byteLength < 12) return null;
		seconds = view.getUint32(4) * 2 ** 32 + view.getUint32(8);
	} else {
		seconds = view.getUint32(4);
	}
	if (seconds <= 0) return null;

	const milliseconds = seconds * 1000 - QUICKTIME_EPOCH_OFFSET_MS;
	return isPlausibleDate(milliseconds) ? milliseconds : null;
};

/**
 * Reads the ISO-BMFF header creation time (MP4/MOV/3GP), i.e. the value Windows reports as
 * "Media created". Only the handful of bytes the box walk needs are read from disk.
 */
export const readContainerCreationDate = async (file: Blob): Promise<number | null> => {
	try {
		const moov = await findBox(file, 0, file.size, ['moov']);
		if (!moov) return null;

		const mvhd = await findBox(file, moov.contentStart, moov.end, ['mvhd']);
		if (mvhd) {
			const date = await readHeaderDate(file, mvhd);
			if (date !== null) return date;
		}

		// Some recorders leave `mvhd` at zero but still date the individual tracks.
		let offset = moov.contentStart;
		for (let visited = 0; visited < MAX_BOXES_PER_LEVEL && offset < moov.end; visited++) {
			const trak = await findBox(file, offset, moov.end, ['trak']);
			if (!trak) break;
			const tkhd = await findBox(file, trak.contentStart, trak.end, ['tkhd']);
			if (tkhd) {
				const date = await readHeaderDate(file, tkhd);
				if (date !== null) return date;
			}
			if (trak.end <= offset) break;
			offset = trak.end;
		}
		return null;
	} catch {
		return null;
	}
};

const FILENAME_DATE_PATTERN =
	/(19|20)(\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _tT.-]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})/;

/**
 * Pulls a wall-clock timestamp out of names like `VID_20240501_102233.mp4`,
 * `2024-05-01 10.22.33.mov` or `PXL_20240501_102233123.mp4`. Names carry local time, so the value
 * is built in the local zone. Returns null unless the name holds a complete, valid date and time.
 */
export const parseCreationDateFromName = (name: string): number | null => {
	const match = FILENAME_DATE_PATTERN.exec(name);
	if (!match) return null;

	const year = Number(`${match[1]}${match[2]}`);
	const month = Number(match[3]);
	const day = Number(match[4]);
	const hour = Number(match[5]);
	const minute = Number(match[6]);
	const second = Number(match[7]);
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

	const date = new Date(year, month - 1, day, hour, minute, second);
	// Rejects impossible days such as 20240231, which the Date constructor would roll over.
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	const milliseconds = date.getTime();
	return isPlausibleDate(milliseconds) ? milliseconds : null;
};

/**
 * ISO-BMFF header times are specified as UTC, but a great many cameras write the local wall clock
 * into that field instead. The file's modified time is the tie-breaker: it is a true Unix
 * timestamp taken at (or shortly after) the recording, so whichever reading lands closer to it is
 * the one the camera meant. Both readings are identical in UTC, so nothing changes there.
 */
export const alignContainerDate = (containerDate: number, modifiedAt: number | null): number => {
	if (!isPlausibleDate(modifiedAt)) return containerDate;
	const asLocalClock = containerDate + new Date(containerDate).getTimezoneOffset() * 60_000;
	if (asLocalClock === containerDate) return containerDate;
	const utcDistance = Math.abs(containerDate - modifiedAt);
	const localDistance = Math.abs(asLocalClock - modifiedAt);
	return localDistance + LOCAL_CLOCK_MARGIN_MS < utcDistance ? asLocalClock : containerDate;
};

export interface CreationDateCandidates {
	/** Date reported by the demuxer's metadata tags, when the file carries one. */
	metadataDate?: number | null;
	/** Date read from the ISO-BMFF header ("Media created"). */
	containerDate?: number | null;
	/** Date parsed out of the file name. */
	filenameDate?: number | null;
}

export interface ResolvedCreationDate {
	value: number | null;
	source: CreationDateSource | null;
}

/** Picks the most trustworthy recording time among everything that could be read. */
export const resolveCreationDate = (candidates: CreationDateCandidates): ResolvedCreationDate => {
	if (isPlausibleDate(candidates.metadataDate ?? null)) {
		return { value: candidates.metadataDate!, source: 'metadata' };
	}
	if (isPlausibleDate(candidates.containerDate ?? null)) {
		return { value: candidates.containerDate!, source: 'container' };
	}
	if (isPlausibleDate(candidates.filenameDate ?? null)) {
		return { value: candidates.filenameDate!, source: 'filename' };
	}
	return { value: null, source: null };
};

export const CREATION_DATE_SOURCE_LABELS: Record<CreationDateSource, string> = {
	metadata: 'video metadata tag',
	container: 'container "Media created" time',
	filename: 'file name',
	modified: 'file modified time',
};
