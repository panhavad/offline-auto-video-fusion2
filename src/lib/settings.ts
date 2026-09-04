import type { FrameRateSetting, MergeSettings, SortDirection, SortKey } from '../types';

const STORAGE_KEY = 'auto-video-fusion:settings:v1';

const sanitizeFrameRate = (value: unknown): FrameRateSetting => {
	if (value === 'auto') return 'auto';
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_SETTINGS.frameRate;
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
	quality: 'high',
	frameRate: 'auto',
	includeAudio: true,
	preferHardware: true,
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
			resolution: DEFAULT_SETTINGS.resolution,
			quality: DEFAULT_SETTINGS.quality,
			frameRate: sanitizeFrameRate(parsed.frameRate),
			includeAudio: DEFAULT_SETTINGS.includeAudio,
			preferHardware: DEFAULT_SETTINGS.preferHardware,
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
