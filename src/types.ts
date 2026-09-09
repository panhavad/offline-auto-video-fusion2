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
export type SortKey = 'name' | 'modified' | 'created';
export type SortDirection = 'asc' | 'desc';
export type ResolutionPreset = 'auto' | '2160' | '1440' | '1080' | '720' | '480';
/** `auto` keeps the first clip's shape; every other value forces a width:height ratio. */
export type AspectRatioSetting = 'auto' | '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '4:5' | '21:9';
export type QualityPreset = 'high' | 'medium' | 'low';
/** Strength of the software (optical-flow) stabilizer; `off` skips the analysis pass entirely. */
export type StabilizerSetting = 'off' | 'light' | 'standard' | 'strong';
/**
 * How much of the machine the merge pipeline may use. `auto` scales with the detected CPU/GPU,
 * `max` pushes every core into the pipeline, and `safe` falls back to the single-threaded pipeline.
 */
export type AccelerationMode = 'auto' | 'max' | 'balanced' | 'safe';
/** `auto` derives the cap from the selected clips; a number is an explicit upper limit in fps. */
export type FrameRateSetting = number | 'auto';

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
	fit: FitMode;
	resolution: ResolutionPreset;
	aspectRatio: AspectRatioSetting;
	quality: QualityPreset;
	frameRate: FrameRateSetting;
	stabilize: StabilizerSetting;
	includeAudio: boolean;
	preferHardware: boolean;
	accelerationMode: AccelerationMode;
}

export interface MergeItem {
	id: string;
	name: string;
	file: File;
	/** Trimmed duration in seconds, estimated while probing. Used for progress reporting. */
	plannedSeconds: number;
	/** Frame rate measured while probing, or null when it could not be determined. */
	sourceFrameRate: number | null;
}

export type MergeTarget =
	| { kind: 'file'; handle: FileSystemFileHandle }
	| { kind: 'buffer' };

export interface MergeRequest {
	items: MergeItem[];
	settings: MergeSettings;
	target: MergeTarget;
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
