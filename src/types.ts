import type { CreationDateSource } from './lib/video-date';

export type Orientation = 'landscape' | 'portrait' | 'any';
export type ClipOrientation = 'landscape' | 'portrait' | 'square';

export type TitlePosition =
	| 'top-left'
	| 'top-center'
	| 'top-right'
	| 'middle-left'
	| 'middle-center'
	| 'middle-right'
	| 'bottom-left'
	| 'bottom-center'
	| 'bottom-right';

export type FitMode = 'contain' | 'cover';
export type SortKey = 'name' | 'modified' | 'created' | 'manual';
export type SortDirection = 'asc' | 'desc';
export type ResolutionPreset = 'auto' | '2160' | '1440' | '1080' | '720' | '480';
/** `auto` keeps the first clip's shape; every other value forces a width:height ratio. */
export type AspectRatioSetting = 'auto' | '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '4:5' | '21:9';
export type QualityPreset = 'high' | 'medium' | 'low';
/** Strength of the software (optical-flow) stabilizer; `off` skips the analysis pass entirely. */
export type StabilizerSetting = 'off' | 'light' | 'standard' | 'strong';
/** How automatically detected faces are obscured; `off` skips face detection entirely. */
export type FaceBlurSetting = 'off' | 'blur' | 'strong' | 'pixelate';
/**
 * How much of the machine the merge pipeline may use. `auto` scales with the detected CPU/GPU,
 * `max` pushes every core into the pipeline, and `safe` falls back to the single-threaded pipeline.
 */
export type AccelerationMode = 'auto' | 'max' | 'balanced' | 'safe';
/** `auto` derives the cap from the selected clips; a number is an explicit upper limit in fps. */
export type FrameRateSetting = number | 'auto';
/** `merge` concatenates the clips; `highlight` cuts a short social-media reel from all of them. */
export type OutputMode = 'merge' | 'highlight';
/** Frame shape of a highlight reel: vertical for TikTok/Reels/Shorts, landscape for YouTube. */
export type HighlightFormat = '9:16' | '16:9';
/** Which part of each clip a highlight segment is taken from. */
export type HighlightPick = 'middle' | 'start' | 'end';
/** `blur` letterboxes each clip over a blurred, zoomed copy of itself; `crop` fills the frame. */
export type HighlightFraming = 'blur' | 'crop';
/** Cut effect between highlight segments; `mix` cycles through every style. */
export type TransitionStyle = 'none' | 'mix' | 'zoom' | 'whip' | 'flash' | 'glitch' | 'spin' | 'dip';
export type TextStyle = 'classic' | 'bold' | 'caption' | 'neon' | 'meme' | 'pop';
export type GpsMapPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type GpsMapBackground = 'plain' | 'map';
export type GpsInfoItem = 'altitude' | 'distance' | 'date-time' | 'speed' | 'coordinates';

export interface GpsPoint {
	latitude: number;
	longitude: number;
	/** Unix time in milliseconds, or null for an untimed route. */
	timestamp: number | null;
	/** Metres above sea level when supplied by the GPS file. */
	elevation: number | null;
	/** Metres per second when supplied by the GPS file. */
	speed: number | null;
}

export interface GpsTrack {
	name: string;
	points: GpsPoint[];
}

export interface GeoPoint {
	latitude: number;
	longitude: number;
}

/** Where the camera says a clip was recorded (e.g. QuickTime ISO 6709 location tag). */
export interface RecordedLocation extends GeoPoint {
	/** Horizontal accuracy in metres, when the camera reported one. */
	accuracy: number | null;
}

export interface ProbeResult {
	ok: boolean;
	error?: string;
	width: number;
	height: number;
	rotation: number;
	duration: number;
	orientation: ClipOrientation;
	frameRate: number | null;
	hasAudio: boolean;
	codec: string | null;
	createdAt: number | null;
	/** Which of the possible clocks {@link createdAt} came from, or null when none had a date. */
	createdAtSource: CreationDateSource | null;
	/** Location embedded in the video by the camera, or null when there is none. */
	location: RecordedLocation | null;
	/** Small JPEG preview of an early frame, or null when no frame could be decoded. */
	thumbnail: Blob | null;
}

export interface MergeSettings {
	orientation: Orientation;
	maxClipSeconds: number;
	title: string;
	titlePosition: TitlePosition;
	titleColor: string;
	titleScale: number;
	titleShadow: boolean;
	textStyle: TextStyle;
	fit: FitMode;
	resolution: ResolutionPreset;
	aspectRatio: AspectRatioSetting;
	quality: QualityPreset;
	frameRate: FrameRateSetting;
	stabilize: StabilizerSetting;
	faceBlur: FaceBlurSetting;
	includeAudio: boolean;
	preferHardware: boolean;
	accelerationMode: AccelerationMode;
	gpsMapPosition: GpsMapPosition;
	/** Mini map width as a percentage of the output frame width. */
	gpsMapSize: number;
	/** Clockwise rotation of the map contents in degrees. */
	gpsMapRotation: number;
	gpsMapBackground: GpsMapBackground;
	/** Opacity of the complete mini-map overlay as a percentage. */
	gpsMapOpacity: number;
	gpsInfoOrder: GpsInfoItem[];
	/**
	 * Minutes a clip may be recorded before the first or after the last GPS fix and still snap to
	 * that end of the track.
	 */
	gpsMatchTolerance: number;
	gpsShowSpeed: boolean;
	gpsShowAltitude: boolean;
	gpsShowDistance: boolean;
	gpsShowCoordinates: boolean;
	gpsShowDateTime: boolean;
	outputMode: OutputMode;
	highlightFormat: HighlightFormat;
	/** Seconds taken from each clip; shortened automatically so every clip fits the reel. */
	highlightClipSeconds: number;
	/** Upper limit of the complete reel, in seconds. */
	highlightMaxSeconds: number;
	highlightPick: HighlightPick;
	highlightFraming: HighlightFraming;
	transition: TransitionStyle;
}

/** The part of a clip that ends up in a highlight reel. */
export interface ClipSegment {
	/** Offset into the clip, in seconds. */
	start: number;
	seconds: number;
}

export interface MergeItem {
	id: string;
	name: string;
	file: File;
	/** Trimmed duration in seconds, estimated while probing. Used for progress reporting. */
	plannedSeconds: number;
	/** Frame rate measured while probing, or null when it could not be determined. */
	sourceFrameRate: number | null;
	/**
	 * Wall-clock time the clip was recorded at: the video metadata tag, else the container header
	 * creation time, else a timestamp in the file name, else the file's modified time. A
	 * timestamped GPS track is matched against this value.
	 */
	recordedAt: number | null;
	/** Which clock {@link recordedAt} came from, used to flag less reliable GPS matches. */
	recordedAtSource: CreationDateSource | null;
	/** Location embedded in the clip, used to verify and rescue GPS matches. */
	recordedLocation: RecordedLocation | null;
	/** Highlight segment to cut from the clip, or null to use it from the start (merge mode). */
	segment: ClipSegment | null;
}

export type MergeTarget =
	| { kind: 'file'; handle: FileSystemFileHandle }
	| { kind: 'buffer' };

export interface MergeRequest {
	items: MergeItem[];
	settings: MergeSettings;
	target: MergeTarget;
	gpsTrack: GpsTrack | null;
}

export type WorkerInMessage =
	| { type: 'probe'; id: string; file: File }
	| { type: 'merge'; request: MergeRequest }
	| { type: 'cancel' };

export interface MergeProgress {
	/** Seconds of source material already encoded. */
	processedSeconds: number;
	/** Total seconds of source material to encode. */
	totalSeconds: number;
	currentIndex: number;
	totalItems: number;
	currentName: string;
	framesEncoded: number;
	fps: number;
	bytesWritten: number;
	elapsedMs: number;
	etaMs: number | null;
}

export type WorkerOutMessage =
	| { type: 'probed'; id: string; result: ProbeResult }
	| { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
	| { type: 'started'; videoCodec: string; audioCodec: string | null; width: number; height: number; frameRate: number }
	| { type: 'progress'; progress: MergeProgress }
	| { type: 'item-done'; id: string; encodedSeconds: number }
	| { type: 'item-failed'; id: string; error: string }
	| { type: 'done'; buffer: ArrayBuffer | null; bytes: number; durationSeconds: number; elapsedMs: number }
	| { type: 'canceled' }
	| { type: 'error'; message: string };
