import type {
	AccelerationMode,
	AspectRatioSetting,
	FaceBlurSetting,
	FrameRateSetting,
	GpsInfoItem,
	GpsMapBackground,
	GpsMapPosition,
	MergeSettings,
	ResolutionPreset,
	SortDirection,
	SortKey,
	StabilizerSetting,
} from '../types';

const STORAGE_KEY = 'auto-video-fusion:settings:v1';

const RESOLUTION_PRESETS: ResolutionPreset[] = ['auto', '2160', '1440', '1080', '720', '480'];

const ASPECT_RATIOS: AspectRatioSetting[] = ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', '4:5', '21:9'];

const STABILIZER_SETTINGS: StabilizerSetting[] = ['off', 'light', 'standard', 'strong'];

const FACE_BLUR_SETTINGS: FaceBlurSetting[] = ['off', 'blur', 'strong', 'pixelate'];

const ACCELERATION_MODES: AccelerationMode[] = ['auto', 'max', 'balanced', 'safe'];
const GPS_MAP_POSITIONS: GpsMapPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const GPS_MAP_BACKGROUNDS: GpsMapBackground[] = ['plain', 'map'];
export const DEFAULT_GPS_INFO_ORDER: GpsInfoItem[] = ['altitude', 'distance', 'date-time', 'speed', 'coordinates'];

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
	sortKey: SortKey;
	sortDirection: SortDirection;
	recursive: boolean;
	theme: 'light' | 'dark';
}

export const DEFAULT_SETTINGS: AppSettings = {
	orientation: 'landscape',
	maxClipSeconds: 20,
	title: '',
	titlePosition: 'bottom-right',
	titleColor: '#FFFFFF',
	titleScale: 3,
	titleShadow: true,
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
	gpsShowSpeed: false,
	gpsShowAltitude: true,
	gpsShowDistance: true,
	gpsShowCoordinates: false,
	gpsShowDateTime: true,
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
			gpsShowSpeed: parsed.gpsShowSpeed ?? DEFAULT_SETTINGS.gpsShowSpeed,
			gpsShowAltitude: parsed.gpsShowAltitude ?? DEFAULT_SETTINGS.gpsShowAltitude,
			gpsShowDistance: parsed.gpsShowDistance ?? DEFAULT_SETTINGS.gpsShowDistance,
			gpsShowCoordinates: parsed.gpsShowCoordinates ?? DEFAULT_SETTINGS.gpsShowCoordinates,
			gpsShowDateTime: parsed.gpsShowDateTime ?? DEFAULT_SETTINGS.gpsShowDateTime,
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
