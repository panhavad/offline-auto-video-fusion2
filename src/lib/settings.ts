import type {
	AccelerationMode,
	AspectRatioSetting,
	FaceBlurSetting,
	FrameRateSetting,
	GpsInfoItem,
	GpsMapBackground,
	GpsMapPosition,
	HighlightFormat,
	HighlightFraming,
	HighlightPick,
	MergeSettings,
	OutputMode,
	ResolutionPreset,
	SortDirection,
	SortKey,
	StabilizerSetting,
	TextStyle,
	TitlePosition,
	TransitionStyle,
} from '../types';
import { DEFAULT_GPS_MATCH_TOLERANCE_MINUTES, GPS_MATCH_TOLERANCE_OPTIONS } from './gps-match';
import {
	DEFAULT_HIGHLIGHT_CLIP_SECONDS,
	DEFAULT_HIGHLIGHT_MAX_SECONDS,
	HIGHLIGHT_CLIP_SECONDS_RANGE,
	HIGHLIGHT_MAX_SECONDS_RANGE,
} from './highlight';

const STORAGE_KEY = 'auto-video-fusion:settings:v1';

const RESOLUTION_PRESETS: ResolutionPreset[] = ['auto', '2160', '1440', '1080', '720', '480'];

const ASPECT_RATIOS: AspectRatioSetting[] = ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', '4:5', '21:9'];

const STABILIZER_SETTINGS: StabilizerSetting[] = ['off', 'light', 'standard', 'strong'];

const FACE_BLUR_SETTINGS: FaceBlurSetting[] = ['off', 'blur', 'strong', 'pixelate'];

const ACCELERATION_MODES: AccelerationMode[] = ['auto', 'max', 'balanced', 'safe'];
const GPS_MAP_POSITIONS: GpsMapPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const GPS_MAP_BACKGROUNDS: GpsMapBackground[] = ['plain', 'map'];
export const DEFAULT_GPS_INFO_ORDER: GpsInfoItem[] = ['altitude', 'distance', 'date-time', 'speed', 'coordinates'];
const OUTPUT_MODES: OutputMode[] = ['merge', 'highlight'];
const HIGHLIGHT_FORMATS: HighlightFormat[] = ['9:16', '16:9'];
const HIGHLIGHT_PICKS: HighlightPick[] = ['middle', 'start', 'end'];
const HIGHLIGHT_FRAMINGS: HighlightFraming[] = ['blur', 'crop'];
const TRANSITIONS: TransitionStyle[] = ['none', 'mix', 'zoom', 'whip', 'flash', 'glitch', 'spin', 'dip'];
const TEXT_STYLES: TextStyle[] = ['classic', 'bold', 'caption', 'neon', 'meme', 'pop'];
const TITLE_POSITIONS: TitlePosition[] = [
	'top-left',
	'top-center',
	'top-right',
	'middle-left',
	'middle-center',
	'middle-right',
	'bottom-left',
	'bottom-center',
	'bottom-right',
];

/** Title size as a percentage of the frame height, as accepted by the size field. */
export const sanitizeTitleScale = (value: unknown, fallback: number): number => {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? Math.min(30, Math.max(2, numeric)) : fallback;
};

const oneOf = <T>(allowed: readonly T[], value: unknown, fallback: T): T =>
	allowed.includes(value as T) ? (value as T) : fallback;

const clampNumber = (value: unknown, range: { min: number; max: number }, fallback: number): number => {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.min(range.max, Math.max(range.min, numeric)) : fallback;
};

export const sanitizeHighlightClipSeconds = (value: unknown): number =>
	Math.round(clampNumber(value, HIGHLIGHT_CLIP_SECONDS_RANGE, DEFAULT_HIGHLIGHT_CLIP_SECONDS) * 10) / 10;

export const sanitizeHighlightMaxSeconds = (value: unknown): number =>
	Math.round(clampNumber(value, HIGHLIGHT_MAX_SECONDS_RANGE, DEFAULT_HIGHLIGHT_MAX_SECONDS));

const sanitizeFrameRate = (value: unknown): FrameRateSetting => {
	if (value === 'auto') return 'auto';
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_SETTINGS.frameRate;
};

const sanitizeResolution = (value: unknown): ResolutionPreset =>
	RESOLUTION_PRESETS.includes(value as ResolutionPreset)
		? (value as ResolutionPreset)
		: DEFAULT_SETTINGS.resolution;

const sanitizeAspectRatio = (value: unknown): AspectRatioSetting =>
	ASPECT_RATIOS.includes(value as AspectRatioSetting)
		? (value as AspectRatioSetting)
		: DEFAULT_SETTINGS.aspectRatio;

const sanitizeStabilizer = (value: unknown): StabilizerSetting =>
	STABILIZER_SETTINGS.includes(value as StabilizerSetting)
		? (value as StabilizerSetting)
		: DEFAULT_SETTINGS.stabilize;

const sanitizeFaceBlur = (value: unknown): FaceBlurSetting =>
	FACE_BLUR_SETTINGS.includes(value as FaceBlurSetting)
		? (value as FaceBlurSetting)
		: DEFAULT_SETTINGS.faceBlur;

const sanitizeAcceleration = (value: unknown): AccelerationMode =>
	ACCELERATION_MODES.includes(value as AccelerationMode)
		? (value as AccelerationMode)
		: DEFAULT_SETTINGS.accelerationMode;

const sanitizeGpsMapPosition = (value: unknown): GpsMapPosition =>
	GPS_MAP_POSITIONS.includes(value as GpsMapPosition)
		? (value as GpsMapPosition)
		: DEFAULT_SETTINGS.gpsMapPosition;

const sanitizeGpsMapSize = (value: unknown): number => {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.min(50, Math.max(15, numeric)) : DEFAULT_SETTINGS.gpsMapSize;
};

const sanitizeGpsMapRotation = (value: unknown): number => {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? ((Math.round(numeric) % 360) + 360) % 360 : DEFAULT_SETTINGS.gpsMapRotation;
};

const sanitizeGpsMapOpacity = (value: unknown): number => {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.min(100, Math.max(10, Math.round(numeric))) : DEFAULT_SETTINGS.gpsMapOpacity;
};

const sanitizeGpsMapBackground = (value: unknown): GpsMapBackground =>
	GPS_MAP_BACKGROUNDS.includes(value as GpsMapBackground)
		? (value as GpsMapBackground)
		: DEFAULT_SETTINGS.gpsMapBackground;

const sanitizeGpsMatchTolerance = (value: unknown): number => {
	const numeric = Number(value);
	return GPS_MATCH_TOLERANCE_OPTIONS.includes(numeric) ? numeric : DEFAULT_SETTINGS.gpsMatchTolerance;
};

const isGpsInfoItem = (value: unknown): value is GpsInfoItem =>
	typeof value === 'string' && DEFAULT_GPS_INFO_ORDER.some((item) => item === value);

const sanitizeGpsInfoOrder = (value: unknown): GpsInfoItem[] => {
	if (!Array.isArray(value)) return [...DEFAULT_GPS_INFO_ORDER];
	const order: GpsInfoItem[] = [];
	for (const item of value) {
		if (isGpsInfoItem(item) && !order.includes(item)) order.push(item);
	}
	for (const item of DEFAULT_GPS_INFO_ORDER) {
		if (!order.includes(item)) order.push(item);
	}
	return order;
};

export interface AppSettings extends MergeSettings {
	/**
	 * A highlight reel keeps its own title look, so switching modes never turns a full merge's
	 * subtle caption into a TikTok headline or the other way round. `titlePosition`, `titleScale`
	 * and `textStyle` hold the full-merge look.
	 */
	highlightTitlePosition: TitlePosition;
	highlightTitleScale: number;
	highlightTextStyle: TextStyle;
	sortKey: SortKey;
	sortDirection: SortDirection;
	recursive: boolean;
	theme: 'light' | 'dark';
}

export const DEFAULT_SETTINGS: AppSettings = {
	orientation: 'landscape',
	keepOriginalRatio: false,
	maxClipSeconds: 20,
	title: '',
	titlePosition: 'bottom-right',
	titleColor: '#FFFFFF',
	titleScale: 4,
	titleShadow: true,
	textStyle: 'classic',
	highlightTitlePosition: 'top-center',
	highlightTitleScale: 5,
	highlightTextStyle: 'bold',
	fit: 'contain',
	resolution: 'auto',
	aspectRatio: 'auto',
	quality: 'high',
	frameRate: 'auto',
	stabilize: 'off',
	faceBlur: 'off',
	includeAudio: true,
	preferHardware: true,
	accelerationMode: 'auto',
	gpsMapPosition: 'bottom-left',
	gpsMapSize: 25,
	gpsMapRotation: 0,
	gpsMapBackground: 'map',
	gpsMapOpacity: 90,
	gpsInfoOrder: [...DEFAULT_GPS_INFO_ORDER],
	gpsMatchTolerance: DEFAULT_GPS_MATCH_TOLERANCE_MINUTES,
	gpsShowSpeed: false,
	gpsShowAltitude: true,
	gpsShowDistance: true,
	gpsShowCoordinates: false,
	gpsShowDateTime: true,
	outputMode: 'merge',
	highlightFormat: '9:16',
	highlightClipSeconds: DEFAULT_HIGHLIGHT_CLIP_SECONDS,
	highlightMaxSeconds: DEFAULT_HIGHLIGHT_MAX_SECONDS,
	highlightPick: 'middle',
	highlightFraming: 'blur',
	transition: 'mix',
	sortKey: 'name',
	sortDirection: 'asc',
	recursive: false,
	theme: 'dark',
};

export const loadSettings = (): AppSettings => {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS, gpsInfoOrder: [...DEFAULT_SETTINGS.gpsInfoOrder] };
		const parsed = JSON.parse(raw) as Partial<AppSettings>;
		return {
			...DEFAULT_SETTINGS,
			...parsed,
			titleShadow: DEFAULT_SETTINGS.titleShadow,
			fit: DEFAULT_SETTINGS.fit,
			resolution: sanitizeResolution(parsed.resolution),
			aspectRatio: sanitizeAspectRatio(parsed.aspectRatio),
			quality: DEFAULT_SETTINGS.quality,
			frameRate: sanitizeFrameRate(parsed.frameRate),
			stabilize: sanitizeStabilizer(parsed.stabilize),
			faceBlur: sanitizeFaceBlur(parsed.faceBlur),
			includeAudio: DEFAULT_SETTINGS.includeAudio,
			preferHardware: DEFAULT_SETTINGS.preferHardware,
			accelerationMode: sanitizeAcceleration(parsed.accelerationMode),
			gpsMapPosition: sanitizeGpsMapPosition(parsed.gpsMapPosition),
			gpsMapSize: sanitizeGpsMapSize(parsed.gpsMapSize),
			gpsMapRotation: sanitizeGpsMapRotation(parsed.gpsMapRotation),
			gpsMapBackground: sanitizeGpsMapBackground(parsed.gpsMapBackground),
			gpsMapOpacity: sanitizeGpsMapOpacity(parsed.gpsMapOpacity),
			gpsInfoOrder: sanitizeGpsInfoOrder(parsed.gpsInfoOrder),
			gpsMatchTolerance: sanitizeGpsMatchTolerance(parsed.gpsMatchTolerance),
			gpsShowSpeed: parsed.gpsShowSpeed ?? DEFAULT_SETTINGS.gpsShowSpeed,
			gpsShowAltitude: parsed.gpsShowAltitude ?? DEFAULT_SETTINGS.gpsShowAltitude,
			gpsShowDistance: parsed.gpsShowDistance ?? DEFAULT_SETTINGS.gpsShowDistance,
			gpsShowCoordinates: parsed.gpsShowCoordinates ?? DEFAULT_SETTINGS.gpsShowCoordinates,
			gpsShowDateTime: parsed.gpsShowDateTime ?? DEFAULT_SETTINGS.gpsShowDateTime,
			textStyle: oneOf(TEXT_STYLES, parsed.textStyle, DEFAULT_SETTINGS.textStyle),
			keepOriginalRatio: parsed.keepOriginalRatio === true,
			highlightTitlePosition: oneOf(TITLE_POSITIONS, parsed.highlightTitlePosition, DEFAULT_SETTINGS.highlightTitlePosition),
			highlightTitleScale: sanitizeTitleScale(parsed.highlightTitleScale, DEFAULT_SETTINGS.highlightTitleScale),
			highlightTextStyle: oneOf(TEXT_STYLES, parsed.highlightTextStyle, DEFAULT_SETTINGS.highlightTextStyle),
			outputMode: oneOf(OUTPUT_MODES, parsed.outputMode, DEFAULT_SETTINGS.outputMode),
			highlightFormat: oneOf(HIGHLIGHT_FORMATS, parsed.highlightFormat, DEFAULT_SETTINGS.highlightFormat),
			highlightClipSeconds: sanitizeHighlightClipSeconds(parsed.highlightClipSeconds),
			highlightMaxSeconds: sanitizeHighlightMaxSeconds(parsed.highlightMaxSeconds),
			highlightPick: oneOf(HIGHLIGHT_PICKS, parsed.highlightPick, DEFAULT_SETTINGS.highlightPick),
			highlightFraming: oneOf(HIGHLIGHT_FRAMINGS, parsed.highlightFraming, DEFAULT_SETTINGS.highlightFraming),
			transition: oneOf(TRANSITIONS, parsed.transition, DEFAULT_SETTINGS.transition),
		};
	} catch {
		return { ...DEFAULT_SETTINGS, gpsInfoOrder: [...DEFAULT_SETTINGS.gpsInfoOrder] };
	}
};

export const saveSettings = (settings: AppSettings): void => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		/* storage unavailable - settings simply won't persist */
	}
};
