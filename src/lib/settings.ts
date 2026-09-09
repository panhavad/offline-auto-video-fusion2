import type {
	AccelerationMode,
	AspectRatioSetting,
	FrameRateSetting,
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

const ACCELERATION_MODES: AccelerationMode[] = ['auto', 'max', 'balanced', 'safe'];

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

const sanitizeAcceleration = (value: unknown): AccelerationMode =>
	ACCELERATION_MODES.includes(value as AccelerationMode)
		? (value as AccelerationMode)
		: DEFAULT_SETTINGS.accelerationMode;

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
	includeAudio: true,
	preferHardware: true,
	accelerationMode: 'auto',
	sortKey: 'name',
	sortDirection: 'asc',
	recursive: false,
	theme: 'dark',
};

export const loadSettings = (): AppSettings => {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
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
			includeAudio: DEFAULT_SETTINGS.includeAudio,
			preferHardware: DEFAULT_SETTINGS.preferHardware,
			accelerationMode: sanitizeAcceleration(parsed.accelerationMode),
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
};

export const saveSettings = (settings: AppSettings): void => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		/* storage unavailable - settings simply won't persist */
	}
};
