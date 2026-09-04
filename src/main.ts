import { formatBytes, formatClock, formatDate, formatDuration, timestampSlug } from './lib/format';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from './lib/settings';
import type {
	MergeItem,
	MergeProgress,
	MergeSettings,
	MergeTarget,
	ProbeResult,
	SortDirection,
	SortKey,
	WorkerInMessage,
	WorkerOutMessage,
} from './types';

const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.qt', '.webm', '.mkv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv'];
const PROBE_CONCURRENCY = 4;
/** Files this app produced (e.g. merged-20250904-101500.mp4) must not become inputs of the next run. */
const OUTPUT_NAME_PATTERN = /^merged-\d{8}-\d{6}\.mp4$/i;

type ClipStatus = 'pending' | 'probing' | 'ready' | 'unreadable' | 'encoding' | 'merged' | 'failed';

interface ClipEntry {
	id: string;
	name: string;
	path: string;
	file: File;
	size: number;
	lastModified: number;
	probe: ProbeResult | null;
	/** Object URL of the probe thumbnail; revoked when the entry list is replaced. */
	thumbnailUrl: string | null;
	status: ClipStatus;
	note: string;
	included: boolean;
}

const el = <T extends HTMLElement>(id: string): T => {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing element #${id}`);
	return node as T;
};

const ui = {
	themeToggle: el<HTMLButtonElement>('theme-toggle'),
	themeColor: el<HTMLMetaElement>('theme-color'),
	offlineBadge: el<HTMLSpanElement>('offline-badge'),
	supportBadge: el<HTMLSpanElement>('support-badge'),
	pickFolder: el<HTMLButtonElement>('pick-folder'),
	rescan: el<HTMLButtonElement>('rescan'),
	recursive: el<HTMLInputElement>('recursive'),
	folderInfo: el<HTMLParagraphElement>('folder-info'),
	fallbackWrap: el<HTMLDivElement>('fallback-wrap'),
	folderInput: el<HTMLInputElement>('folder-input'),
	orientation: el<HTMLSelectElement>('orientation'),
	maxClip: el<HTMLInputElement>('max-clip'),
	titleText: el<HTMLInputElement>('title-text'),
	titlePosition: el<HTMLSelectElement>('title-position'),
	titleColor: el<HTMLInputElement>('title-color'),
	titleColorHex: el<HTMLInputElement>('title-color-hex'),
	titleScale: el<HTMLInputElement>('title-scale'),
	titleShadow: el<HTMLInputElement>('title-shadow'),
	resolution: el<HTMLSelectElement>('resolution'),
	frameRate: el<HTMLSelectElement>('frame-rate'),
	quality: el<HTMLSelectElement>('quality'),
	fit: el<HTMLSelectElement>('fit'),
	includeAudio: el<HTMLInputElement>('include-audio'),
	preferHardware: el<HTMLInputElement>('prefer-hardware'),
	clipCount: el<HTMLSpanElement>('clip-count'),
	sortKey: el<HTMLSelectElement>('sort-key'),
	sortDir: el<HTMLButtonElement>('sort-dir'),
	selectAll: el<HTMLButtonElement>('select-all'),
	selectNone: el<HTMLButtonElement>('select-none'),
	probeStatus: el<HTMLSpanElement>('probe-status'),
	clipRows: el<HTMLTableSectionElement>('clip-rows'),
	clipEmpty: el<HTMLParagraphElement>('clip-empty'),
	mergeSummary: el<HTMLParagraphElement>('merge-summary'),
	start: el<HTMLButtonElement>('start'),
	cancel: el<HTMLButtonElement>('cancel'),
	openOutput: el<HTMLAnchorElement>('open-output'),
	download: el<HTMLAnchorElement>('download'),
	progressWrap: el<HTMLDivElement>('progress-wrap'),
	progressBar: el<HTMLDivElement>('progress-bar'),
	progressPercent: el<HTMLSpanElement>('progress-percent'),
	progressCurrent: el<HTMLSpanElement>('progress-current'),
	progressEta: el<HTMLSpanElement>('progress-eta'),
	statElapsed: el<HTMLSpanElement>('stat-elapsed'),
	statEta: el<HTMLSpanElement>('stat-eta'),
	statEncoded: el<HTMLSpanElement>('stat-encoded'),
	statFps: el<HTMLSpanElement>('stat-fps'),
	statBytes: el<HTMLSpanElement>('stat-bytes'),
	statClip: el<HTMLSpanElement>('stat-clip'),
	log: el<HTMLDivElement>('log'),
};

const settings: AppSettings = loadSettings();
let entries: ClipEntry[] = [];
let directoryHandle: FileSystemDirectoryHandle | null = null;
let directoryLabel = '';
let merging = false;
let starting = false;
let scanToken = 0;
let idCounter = 0;
let downloadUrl: string | null = null;
const generatedOutputs = new Set<string>();

const isGeneratedOutput = (name: string): boolean => OUTPUT_NAME_PATTERN.test(name) || generatedOutputs.has(name);

const pendingProbes = new Map<string, (result: ProbeResult) => void>();

const applyTheme = () => {
	const dark = settings.theme === 'dark';
	document.documentElement.dataset.theme = settings.theme;
	ui.themeToggle.textContent = dark ? 'Light mode' : 'Dark mode';
	ui.themeToggle.setAttribute('aria-pressed', String(dark));
	ui.themeColor.content = dark ? '#18211e' : '#eef3f1';
};

const createWorker = (): Worker => {
	const instance = new Worker(new URL('./worker/pipeline.worker.ts', import.meta.url), { type: 'module' });
	instance.addEventListener('message', handleWorkerMessage);
	instance.addEventListener('error', handleWorkerError);
	return instance;
};

let worker: Worker = createWorker();

const send = (message: WorkerInMessage) => worker.postMessage(message);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const addLog = (message: string, level: 'info' | 'warn' | 'error' | 'ok' = 'info') => {
	const line = document.createElement('div');
	line.className = level;
	const time = new Date().toLocaleTimeString();
	line.textContent = `[${time}] ${message}`;
	ui.log.append(line);
	ui.log.classList.add('has-entries');
	ui.log.scrollTop = ui.log.scrollHeight;
	while (ui.log.childElementCount > 300) ui.log.firstElementChild?.remove();
};

// ---------------------------------------------------------------------------
// Settings <-> form
// ---------------------------------------------------------------------------

const applySettingsToForm = () => {
	ui.orientation.value = settings.orientation;
	ui.maxClip.value = String(settings.maxClipSeconds);
	ui.titleText.value = settings.title;
	ui.titlePosition.value = settings.titlePosition;
	ui.titleColor.value = settings.titleColor;
	ui.titleColorHex.value = settings.titleColor;
	ui.titleScale.value = String(settings.titleScale);
	ui.titleShadow.checked = settings.titleShadow;
	ui.resolution.value = settings.resolution;
	ui.frameRate.value = String(settings.frameRate);
	ui.quality.value = settings.quality;
	ui.fit.value = settings.fit;
	ui.includeAudio.checked = settings.includeAudio;
	ui.preferHardware.checked = settings.preferHardware;
	ui.sortKey.value = settings.sortKey;
	ui.recursive.checked = settings.recursive;
	updateSortButton();
};

const readSettingsFromForm = () => {
	settings.orientation = ui.orientation.value as AppSettings['orientation'];
	settings.maxClipSeconds = Math.max(0, Number(ui.maxClip.value) || 0);
	settings.title = ui.titleText.value;
	settings.titlePosition = ui.titlePosition.value as AppSettings['titlePosition'];
	settings.titleColor = ui.titleColor.value.toUpperCase();
	settings.titleScale = Math.min(30, Math.max(2, Number(ui.titleScale.value) || DEFAULT_SETTINGS.titleScale));
	settings.titleShadow = ui.titleShadow.checked;
	settings.resolution = ui.resolution.value as AppSettings['resolution'];
	settings.frameRate = Number(ui.frameRate.value) || DEFAULT_SETTINGS.frameRate;
	settings.quality = ui.quality.value as AppSettings['quality'];
	settings.fit = ui.fit.value as AppSettings['fit'];
	settings.includeAudio = ui.includeAudio.checked;
	settings.preferHardware = ui.preferHardware.checked;
	settings.sortKey = ui.sortKey.value as SortKey;
	settings.recursive = ui.recursive.checked;
	saveSettings(settings);
};

const updateSortButton = () => {
	ui.sortDir.textContent = settings.sortDirection === 'asc' ? 'Ascending ↑' : 'Descending ↓';
};

const mergeSettings = (): MergeSettings => ({
	orientation: settings.orientation,
	maxClipSeconds: settings.maxClipSeconds,
	title: settings.title.replace(/\\n/g, '\n'),
	titlePosition: settings.titlePosition,
	titleColor: settings.titleColor,
	titleScale: settings.titleScale,
	titleShadow: settings.titleShadow,
	fit: settings.fit,
	resolution: settings.resolution,
	quality: settings.quality,
	frameRate: settings.frameRate,
	includeAudio: settings.includeAudio,
	preferHardware: settings.preferHardware,
});

// ---------------------------------------------------------------------------
// Clip helpers
// ---------------------------------------------------------------------------

const isVideoFile = (file: File): boolean => {
	if (isGeneratedOutput(file.name)) return false;
	if (file.type.startsWith('video/')) return true;
	const lower = file.name.toLowerCase();
	return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

const createdAtOf = (entry: ClipEntry): number => entry.probe?.createdAt ?? entry.lastModified;

const plannedSeconds = (entry: ClipEntry): number => {
	const duration = entry.probe?.duration ?? 0;
	const limit = settings.maxClipSeconds > 0 ? settings.maxClipSeconds : Infinity;
	return Math.min(duration, limit);
};

const orientationMatches = (entry: ClipEntry): boolean => {
	if (!entry.probe?.ok) return false;
	if (settings.orientation === 'any') return true;
	return entry.probe.orientation === settings.orientation;
};

const isEligible = (entry: ClipEntry): boolean =>
	entry.included && Boolean(entry.probe?.ok) && orientationMatches(entry);

const sortedEntries = (): ClipEntry[] => {
	const direction = settings.sortDirection === 'asc' ? 1 : -1;
	return [...entries].sort((a, b) => {
		let result = 0;
		if (settings.sortKey === 'name') {
			result = a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
		} else if (settings.sortKey === 'modified') {
			result = a.lastModified - b.lastModified;
		} else {
			result = createdAtOf(a) - createdAtOf(b);
		}
		if (result === 0) result = a.path.localeCompare(b.path, undefined, { numeric: true });
		return result * direction;
	});
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const statusLabel = (entry: ClipEntry): { text: string; className: string } => {
	if (entry.status === 'probing' || entry.status === 'pending') return { text: 'Reading…', className: 'pill-muted' };
	if (entry.status === 'unreadable') return { text: entry.note || 'Unreadable', className: 'pill-bad' };
	if (entry.status === 'encoding') return { text: 'Encoding…', className: 'pill-warn' };
	if (entry.status === 'merged') return { text: 'Merged', className: 'pill-ok' };
	if (entry.status === 'failed') return { text: entry.note || 'Failed', className: 'pill-bad' };
	if (!entry.included) return { text: 'Excluded', className: 'pill-muted' };
	if (!orientationMatches(entry)) return { text: 'Wrong orientation', className: 'pill-warn' };
	return { text: 'Ready', className: 'pill-ok' };
};

const render = () => {
	const list = sortedEntries();
	const fragment = document.createDocumentFragment();
	let order = 0;

	for (const entry of list) {
		const eligible = isEligible(entry);
		if (eligible) order++;

		const row = document.createElement('tr');
		row.dataset.id = entry.id;
		if (!eligible) row.classList.add('excluded');
		if (entry.status === 'encoding') row.classList.add('active');

		const checkCell = document.createElement('td');
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = entry.included;
		checkbox.disabled = merging;
		checkbox.setAttribute('aria-label', `Include ${entry.path}`);
		checkbox.title = `Include ${entry.path}`;
		checkbox.addEventListener('change', () => {
			entry.included = checkbox.checked;
			render();
		});
		checkCell.append(checkbox);

		const orderCell = document.createElement('td');
		orderCell.textContent = eligible ? String(order) : '—';

		const thumbCell = document.createElement('td');
		thumbCell.className = 'col-thumb';
		if (entry.thumbnailUrl) {
			const thumb = document.createElement('img');
			thumb.className = 'thumb';
			thumb.src = entry.thumbnailUrl;
			thumb.alt = `First frames of ${entry.path}`;
			thumb.title = entry.path;
			thumbCell.append(thumb);
		} else {
			const placeholder = document.createElement('span');
			placeholder.className = 'thumb thumb-empty';
			placeholder.textContent = entry.probe ? '✕' : '…';
			placeholder.title = entry.probe ? 'No preview frame could be decoded' : 'Reading video…';
			thumbCell.append(placeholder);
		}

		const nameCell = document.createElement('td');
		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = entry.path;
		name.title = entry.path;
		nameCell.append(name);

		const sizeCell = document.createElement('td');
		sizeCell.textContent = formatBytes(entry.size);

		const resolutionCell = document.createElement('td');
		resolutionCell.textContent = entry.probe?.ok ? `${entry.probe.width}×${entry.probe.height}` : '—';

		const orientationCell = document.createElement('td');
		orientationCell.textContent = entry.probe?.ok ? entry.probe.orientation : '—';

		const lengthCell = document.createElement('td');
		lengthCell.textContent = entry.probe?.ok ? formatDuration(entry.probe.duration) : '—';

		const createdCell = document.createElement('td');
		createdCell.textContent = formatDate(entry.probe?.createdAt ?? null);
		if (!entry.probe?.createdAt) createdCell.title = 'No creation date in the file metadata; modified date is used for sorting.';

		const modifiedCell = document.createElement('td');
		modifiedCell.textContent = formatDate(entry.lastModified);

		const statusCell = document.createElement('td');
		const status = statusLabel(entry);
		const pill = document.createElement('span');
		pill.className = `pill ${status.className}`;
		pill.textContent = status.text;
		if (entry.note) pill.title = entry.note;
		statusCell.append(pill);

		row.append(
			checkCell,
			orderCell,
			thumbCell,
			nameCell,
			sizeCell,
			resolutionCell,
			orientationCell,
			lengthCell,
			createdCell,
			modifiedCell,
			statusCell,
		);
		fragment.append(row);
	}

	ui.clipRows.replaceChildren(fragment);
	ui.clipEmpty.classList.toggle('hidden', entries.length > 0);
	ui.clipCount.textContent = `${order} / ${entries.length}`;
	updateSummary();
};

const updateSummary = () => {
	const eligible = sortedEntries().filter(isEligible);
	const totalSource = eligible.reduce((sum, entry) => sum + plannedSeconds(entry), 0);
	const probing = entries.some((entry) => entry.status === 'pending' || entry.status === 'probing');

	if (entries.length === 0) {
		ui.mergeSummary.textContent = 'Nothing to merge yet.';
	} else if (eligible.length === 0) {
		ui.mergeSummary.textContent = probing
			? 'Reading video metadata…'
			: 'No clip matches the current orientation filter.';
	} else {
		const trimmed = eligible.filter((entry) => settings.maxClipSeconds > 0 && (entry.probe?.duration ?? 0) > settings.maxClipSeconds).length;
		ui.mergeSummary.textContent =
			`${eligible.length} clip${eligible.length === 1 ? '' : 's'} · merged length ≈ ${formatDuration(totalSource)}` +
			`${trimmed > 0 ? ` · ${trimmed} will be trimmed to ${settings.maxClipSeconds}s` : ''}` +
			`${probing ? ' · still reading metadata…' : ''}` +
			` · order: ${settings.sortKey} ${settings.sortDirection === 'asc' ? '↑' : '↓'}`;
	}

	ui.start.disabled = merging || starting || probing || eligible.length === 0;
	ui.start.title = probing ? 'Waiting for video metadata…' : '';
};

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

const probeEntry = (entry: ClipEntry): Promise<ProbeResult> =>
	new Promise<ProbeResult>((resolve) => {
		pendingProbes.set(entry.id, resolve);
		send({ type: 'probe', id: entry.id, file: entry.file });
	});

const probeAll = async () => {
	const queue = entries.filter((entry) => entry.status === 'pending');
	if (queue.length === 0) return;

	let done = 0;
	let cursor = 0;
	const total = queue.length;
	ui.probeStatus.textContent = `Reading metadata 0/${total}…`;

	const runNext = async (): Promise<void> => {
		while (cursor < queue.length) {
			const entry = queue[cursor++];
			entry.status = 'probing';
			const result = await probeEntry(entry);
			entry.probe = result;
			if (result.thumbnail) {
				if (entry.thumbnailUrl) URL.revokeObjectURL(entry.thumbnailUrl);
				entry.thumbnailUrl = URL.createObjectURL(result.thumbnail);
			}
			if (result.ok) {
				entry.status = 'ready';
				entry.note = '';
			} else {
				entry.status = 'unreadable';
				entry.note = result.error ?? 'Unreadable';
				entry.included = false;
			}
			done++;
			ui.probeStatus.textContent = `Reading metadata ${done}/${total}…`;
			if (done % 4 === 0 || done === total) render();
		}
	};

	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, runNext));
	ui.probeStatus.textContent = `${entries.filter((entry) => entry.probe?.ok).length} readable of ${entries.length}`;
	render();
};

// ---------------------------------------------------------------------------
// Folder handling
// ---------------------------------------------------------------------------

const addFiles = (files: { file: File; path: string }[]) => {
	// Any in-flight directory scan must not overwrite this list.
	scanToken++;
	for (const entry of entries) {
		if (entry.thumbnailUrl) URL.revokeObjectURL(entry.thumbnailUrl);
	}
	entries = files.map(({ file, path }) => ({
		id: `clip-${++idCounter}`,
		name: file.name,
		path,
		file,
		size: file.size,
		lastModified: file.lastModified,
		probe: null,
		thumbnailUrl: null,
		status: 'pending' as ClipStatus,
		note: '',
		included: true,
	}));
	render();
	void probeAll();
};

const collectFromDirectory = async (
	handle: FileSystemDirectoryHandle,
	prefix: string,
	recursive: boolean,
	out: { file: File; path: string }[],
) => {
	for await (const child of handle.values()) {
		if (child.kind === 'file') {
			const file = await (child as FileSystemFileHandle).getFile();
			if (isVideoFile(file)) out.push({ file, path: `${prefix}${file.name}` });
		} else if (recursive && child.kind === 'directory') {
			await collectFromDirectory(child as FileSystemDirectoryHandle, `${prefix}${child.name}/`, true, out);
		}
	}
};

const scanDirectory = async () => {
	if (!directoryHandle) return;
	const token = ++scanToken;
	const handle = directoryHandle;
	const label = directoryLabel;
	ui.folderInfo.textContent = `Scanning “${label}”…`;
	const found: { file: File; path: string }[] = [];
	try {
		await collectFromDirectory(handle, '', settings.recursive, found);
	} catch (error) {
		addLog(`Could not read the folder: ${error instanceof Error ? error.message : String(error)}`, 'error');
	}
	// A newer scan (or another folder) started meanwhile - drop this stale result.
	if (token !== scanToken) return;
	ui.folderInfo.textContent = `“${label}” — ${found.length} video file${found.length === 1 ? '' : 's'} found. Files stay on your disk.`;
	ui.rescan.disabled = false;
	addFiles(found);
};

const pickFolder = async () => {
	if (!window.showDirectoryPicker) {
		ui.fallbackWrap.classList.remove('hidden');
		ui.folderInput.click();
		return;
	}
	try {
		const handle = await window.showDirectoryPicker({ id: 'auto-video-fusion', mode: 'readwrite' });
		directoryHandle = handle;
		directoryLabel = handle.name;
		await scanDirectory();
	} catch (error) {
		if ((error as DOMException)?.name !== 'AbortError') {
			addLog(`Folder selection failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
		}
	}
};

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

const setBusy = (busy: boolean) => {
	merging = busy;
	const controls: HTMLElement[] = [
		ui.pickFolder,
		ui.rescan,
		ui.recursive,
		ui.orientation,
		ui.maxClip,
		ui.titleText,
		ui.titlePosition,
		ui.titleColor,
		ui.titleColorHex,
		ui.titleScale,
		ui.titleShadow,
		ui.resolution,
		ui.frameRate,
		ui.quality,
		ui.fit,
		ui.includeAudio,
		ui.preferHardware,
		ui.sortKey,
		ui.sortDir,
		ui.selectAll,
		ui.selectNone,
		ui.folderInput,
	];
	for (const control of controls) (control as HTMLInputElement).disabled = busy;
	ui.start.classList.toggle('hidden', busy);
	ui.cancel.classList.toggle('hidden', !busy);
	ui.cancel.disabled = false;
	if (busy) ui.progressWrap.classList.remove('hidden');
};

const resetProgressUi = () => {
	ui.progressWrap.classList.remove('hidden');
	ui.progressBar.style.width = '0%';
	ui.progressPercent.textContent = '0%';
	ui.progressCurrent.textContent = 'Preparing…';
	ui.progressEta.textContent = '';
	ui.statElapsed.textContent = '0:00';
	ui.statEta.textContent = '—';
	ui.statEncoded.textContent = '0:00 / 0:00';
	ui.statFps.textContent = '0 fps';
	ui.statBytes.textContent = '0 B';
	ui.statClip.textContent = '0 / 0';
};

const showProgress = (progress: MergeProgress) => {
	const ratio = progress.totalSeconds > 0 ? Math.min(1, progress.processedSeconds / progress.totalSeconds) : 0;
	const percent = Math.round(ratio * 100);
	ui.progressBar.style.width = `${percent}%`;
	ui.progressPercent.textContent = `${percent}%`;
	ui.progressCurrent.textContent = progress.currentName ? `Clip ${Math.min(progress.currentIndex + 1, progress.totalItems)}/${progress.totalItems}: ${progress.currentName}` : '';
	ui.progressEta.textContent = progress.etaMs !== null ? `~${formatClock(progress.etaMs)} left` : '';
	ui.statElapsed.textContent = formatClock(progress.elapsedMs);
	ui.statEta.textContent = progress.etaMs !== null ? formatClock(progress.etaMs) : '—';
	ui.statEncoded.textContent = `${formatDuration(progress.processedSeconds)} / ${formatDuration(progress.totalSeconds)}`;
	ui.statFps.textContent = `${progress.fps.toFixed(1)} fps`;
	ui.statBytes.textContent = outputIsBuffer ? 'in memory' : formatBytes(progress.bytesWritten);
	ui.statClip.textContent = `${Math.min(progress.currentIndex + 1, progress.totalItems)} / ${progress.totalItems}`;
};

const createOutputTarget = async (
	fileName: string,
): Promise<{ target: MergeTarget; where: string; handle?: FileSystemFileHandle; discard?: () => Promise<void> } | null> => {
	if (directoryHandle) {
		try {
			const permission = (await directoryHandle.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
			if (permission === 'granted') {
				const directory = directoryHandle;
				const handle = await directory.getFileHandle(fileName, { create: true });
				return {
					target: { kind: 'file', handle },
					where: `${directoryLabel}/${fileName}`,
					handle,
					discard: () => directory.removeEntry(fileName),
				};
			}
		} catch (error) {
			addLog(`Cannot write into the source folder (${error instanceof Error ? error.message : String(error)}).`, 'warn');
		}
	}

	if (window.showSaveFilePicker) {
		try {
			const handle = await window.showSaveFilePicker({
				suggestedName: fileName,
				types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
			});
			generatedOutputs.add(handle.name);
			return {
				target: { kind: 'file', handle },
				where: handle.name,
				handle,
				// The parent folder is unknown here, so the best we can do is empty the file.
				discard: async () => {
					const writable = await handle.createWritable();
					await writable.close();
				},
			};
		} catch (error) {
			if ((error as DOMException)?.name === 'AbortError') return null;
			addLog(`Save dialog failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
		}
	}

	// No picker available (e.g. Firefox/Safari): stream into private browser storage instead of
	// building the whole file in memory, then hand it to the user as a download.
	try {
		const opfs = await navigator.storage.getDirectory();
		await releaseTemporaryOutput();
		const handle = await opfs.getFileHandle(fileName, { create: true });
		temporaryOutput = { directory: opfs, handle };
		return {
			target: { kind: 'file', handle },
			where: 'browser storage (offered as a download)',
			handle,
			discard: () => releaseTemporaryOutput(),
		};
	} catch {
		return { target: { kind: 'buffer' }, where: 'memory (offered as a download)' };
	}
};

let outputLocation = '';
let outputFileName = 'merged.mp4';
let outputIsBuffer = false;
let outputFileHandle: FileSystemFileHandle | null = null;
let discardOutput: (() => Promise<void>) | null = null;
let temporaryOutput: { directory: FileSystemDirectoryHandle; handle: FileSystemFileHandle } | null = null;

/** Drops the previous temporary (private storage) output so it cannot pile up on disk. */
const releaseTemporaryOutput = async () => {
	if (downloadUrl) {
		URL.revokeObjectURL(downloadUrl);
		downloadUrl = null;
	}
	if (!temporaryOutput) return;
	const previous = temporaryOutput;
	temporaryOutput = null;
	try {
		await previous.directory.removeEntry(previous.handle.name);
	} catch {
		/* nothing to clean up */
	}
};

/** Removes staging files left behind by earlier sessions (e.g. after a reload or a crash). */
const cleanupTemporaryOutputs = async () => {
	try {
		const opfs = await navigator.storage.getDirectory();
		const stale: string[] = [];
		for await (const [name] of opfs.entries()) {
			if (OUTPUT_NAME_PATTERN.test(name)) stale.push(name);
		}
		for (const name of stale) {
			await opfs.removeEntry(name).catch(() => undefined);
		}
	} catch {
		/* private storage unavailable - nothing to clean */
	}
};

const publishOutputActions = async (buffer: ArrayBuffer | null) => {
	let blob: Blob | null = null;
	if (buffer) {
		blob = new Blob([buffer], { type: 'video/mp4' });
	} else if (outputFileHandle) {
		// A file-backed Blob lets the browser open the result without copying it into memory.
		blob = await outputFileHandle.getFile();
	}
	if (!blob) return;

	if (downloadUrl) URL.revokeObjectURL(downloadUrl);
	downloadUrl = URL.createObjectURL(blob);
	ui.download.href = downloadUrl;
	ui.download.download = outputFileName;
	ui.openOutput.href = downloadUrl;
	ui.openOutput.classList.remove('hidden');
	ui.download.classList.remove('hidden');
};

const discardPartialOutput = async () => {
	if (!discardOutput) return;
	const discard = discardOutput;
	discardOutput = null;
	try {
		await discard();
		addLog('Partial output file removed.', 'warn');
	} catch (error) {
		addLog(`Could not remove the partial output file: ${error instanceof Error ? error.message : String(error)}`, 'warn');
	}
};

const startMerge = async () => {
	if (merging || starting) return;
	starting = true;
	try {
		readSettingsFromForm();

		const eligible = sortedEntries().filter(isEligible);
		if (eligible.length === 0) {
			addLog('Nothing to merge - no clip matches the current filters.', 'warn');
			return;
		}
		if (entries.some((entry) => entry.status === 'pending' || entry.status === 'probing')) {
			addLog('Still reading video metadata - try again in a moment.', 'warn');
			return;
		}

		ui.download.classList.add('hidden');
		ui.openOutput.classList.add('hidden');
		outputFileName = `merged-${timestampSlug()}.mp4`;
		generatedOutputs.add(outputFileName);

		const output = await createOutputTarget(outputFileName);
		if (!output) return;
		outputLocation = output.where;
		outputIsBuffer = output.target.kind === 'buffer';
		outputFileHandle = output.handle ?? null;
		discardOutput = output.discard ?? null;

		const items: MergeItem[] = eligible.map((entry) => {
			entry.status = 'encoding';
			entry.note = '';
			return {
				id: entry.id,
				name: entry.path,
				file: entry.file,
				plannedSeconds: plannedSeconds(entry),
			};
		});

		setBusy(true);
		resetProgressUi();
		render();
		addLog(`Merging ${items.length} clip${items.length === 1 ? '' : 's'} → ${output.where}`);
		send({ type: 'merge', request: { items, settings: mergeSettings(), target: output.target } });
	} finally {
		starting = false;
		updateSummary();
	}
};

const finishMerge = (discardResults = false) => {
	setBusy(false);
	for (const entry of entries) {
		if (entry.status === 'encoding' || (discardResults && entry.status === 'merged')) {
			entry.status = entry.probe?.ok ? 'ready' : 'unreadable';
			entry.note = '';
		}
	}
	render();
};

// ---------------------------------------------------------------------------
// Worker messages
// ---------------------------------------------------------------------------

function handleWorkerMessage(event: MessageEvent<WorkerOutMessage>) {
	const message = event.data;
	switch (message.type) {
		case 'probed': {
			const resolve = pendingProbes.get(message.id);
			pendingProbes.delete(message.id);
			resolve?.(message.result);
			break;
		}
		case 'log':
			addLog(message.message, message.level);
			break;
		case 'started':
			addLog(
				`Output: ${message.width}×${message.height}, video ${message.videoCodec.toUpperCase()}, audio ${message.audioCodec?.toUpperCase() ?? 'none'}.`,
			);
			break;
		case 'progress':
			showProgress(message.progress);
			for (const entry of entries) {
				if (entry.status === 'encoding') {
					const isCurrent = entry.path === message.progress.currentName;
					const row = ui.clipRows.querySelector<HTMLTableRowElement>(`tr[data-id="${entry.id}"]`);
					row?.classList.toggle('active', isCurrent);
				}
			}
			break;
		case 'item-done': {
			const entry = entries.find((candidate) => candidate.id === message.id);
			if (entry) {
				entry.status = 'merged';
				entry.note = `Encoded ${formatDuration(message.encodedSeconds)}`;
			}
			render();
			break;
		}
		case 'item-failed': {
			const entry = entries.find((candidate) => candidate.id === message.id);
			if (entry) {
				entry.status = 'failed';
				entry.note = message.error;
			}
			render();
			break;
		}
		case 'done': {
			discardOutput = null;
			void publishOutputActions(message.buffer);
			addLog(
				`Done in ${formatClock(message.elapsedMs)} — ${formatDuration(message.durationSeconds)} of video, ${formatBytes(message.bytes)} → ${outputLocation}.`,
				'ok',
			);
			ui.progressBar.style.width = '100%';
			ui.progressPercent.textContent = '100%';
			ui.progressCurrent.textContent = 'Finished';
			ui.progressEta.textContent = '';
			ui.statBytes.textContent = formatBytes(message.bytes);
			finishMerge();
			break;
		}
		case 'canceled':
			addLog('Merge canceled.', 'warn');
			ui.progressCurrent.textContent = 'Canceled';
			void discardPartialOutput();
			finishMerge(true);
			break;
		case 'error':
			addLog(`Merge failed: ${message.message}`, 'error');
			ui.progressCurrent.textContent = 'Failed';
			void discardPartialOutput();
			finishMerge(true);
			break;
	}
}

function handleWorkerError(event: ErrorEvent) {
	addLog(`Background worker crashed: ${event.message}. Restarting it…`, 'error');

	// Unblock everything that was waiting on the dead worker, then bring up a fresh one.
	for (const [id, resolve] of pendingProbes) {
		resolve({
			ok: false,
			error: 'Worker crashed while reading this file',
			width: 0,
			height: 0,
			rotation: 0,
			duration: 0,
			orientation: 'landscape',
			frameRate: null,
			hasAudio: false,
			codec: null,
			createdAt: null,
			thumbnail: null,
		});
		pendingProbes.delete(id);
	}

	worker.removeEventListener('message', handleWorkerMessage);
	worker.removeEventListener('error', handleWorkerError);
	worker.terminate();
	worker = createWorker();

	if (merging) {
		ui.progressCurrent.textContent = 'Failed';
		void discardPartialOutput();
	}
	finishMerge(true);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

ui.themeToggle.addEventListener('click', () => {
	settings.theme = settings.theme === 'light' ? 'dark' : 'light';
	applyTheme();
	saveSettings(settings);
});

ui.pickFolder.addEventListener('click', () => void pickFolder());

ui.rescan.addEventListener('click', () => {
	readSettingsFromForm();
	void scanDirectory();
});

ui.folderInput.addEventListener('change', () => {
	const files = Array.from(ui.folderInput.files ?? []).filter(isVideoFile);
	directoryHandle = null;
	directoryLabel = 'selected files';
	ui.folderInfo.textContent = `${files.length} video file${files.length === 1 ? '' : 's'} selected. The merged file will be offered as a download.`;
	addFiles(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })));
});

for (const control of [
	ui.orientation,
	ui.maxClip,
	ui.titleText,
	ui.titlePosition,
	ui.titleScale,
	ui.titleShadow,
	ui.resolution,
	ui.frameRate,
	ui.quality,
	ui.fit,
	ui.includeAudio,
	ui.preferHardware,
	ui.recursive,
]) {
	control.addEventListener('change', () => {
		readSettingsFromForm();
		render();
	});
}

ui.titleColor.addEventListener('input', () => {
	ui.titleColorHex.value = ui.titleColor.value.toUpperCase();
	readSettingsFromForm();
});

ui.titleColorHex.addEventListener('change', () => {
	const value = ui.titleColorHex.value.trim();
	if (/^#[0-9a-f]{6}$/i.test(value)) {
		ui.titleColor.value = value;
		readSettingsFromForm();
	} else {
		ui.titleColorHex.value = ui.titleColor.value.toUpperCase();
	}
});

ui.sortKey.addEventListener('change', () => {
	readSettingsFromForm();
	render();
});

ui.sortDir.addEventListener('click', () => {
	settings.sortDirection = settings.sortDirection === 'asc' ? 'desc' : ('asc' as SortDirection);
	updateSortButton();
	saveSettings(settings);
	render();
});

ui.selectAll.addEventListener('click', () => {
	for (const entry of entries) if (entry.probe?.ok) entry.included = true;
	render();
});

ui.selectNone.addEventListener('click', () => {
	for (const entry of entries) entry.included = false;
	render();
});

ui.start.addEventListener('click', () => void startMerge());

ui.cancel.addEventListener('click', () => {
	ui.cancel.disabled = true;
	send({ type: 'cancel' });
	addLog('Cancel requested…', 'warn');
});

window.addEventListener('beforeunload', (event) => {
	if (merging) {
		event.preventDefault();
		event.returnValue = '';
	}
});

// ---------------------------------------------------------------------------
// Capability + offline status
// ---------------------------------------------------------------------------

const reportCapabilities = () => {
	const hasCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
	const hasFs = typeof window.showDirectoryPicker === 'function';
	if (!hasCodecs) {
		ui.supportBadge.textContent = 'WebCodecs missing';
		ui.supportBadge.className = 'pill pill-bad';
		ui.start.disabled = true;
		addLog('This browser has no WebCodecs support. Use Chrome, Edge or another Chromium browser.', 'error');
	} else if (!hasFs) {
		ui.supportBadge.textContent = 'No folder access';
		ui.supportBadge.className = 'pill pill-warn';
		ui.fallbackWrap.classList.remove('hidden');
		addLog('The File System Access API is unavailable, so folder picking uses the fallback input and the result is downloaded.', 'warn');
	} else {
		// Everything is supported — no need to advertise capabilities in the UI.
		ui.supportBadge.textContent = '';
		ui.supportBadge.className = 'pill pill-muted hidden';
	}
};

const registerServiceWorker = async () => {
	if (!('serviceWorker' in navigator)) {
		ui.offlineBadge.textContent = 'Offline: unavailable';
		ui.offlineBadge.className = 'pill pill-warn';
		return;
	}
	if (import.meta.env.DEV) {
		ui.offlineBadge.textContent = 'Offline: dev mode';
		ui.offlineBadge.className = 'pill pill-muted';
		return;
	}

	ui.offlineBadge.textContent = 'Offline: caching…';
	ui.offlineBadge.className = 'pill pill-muted';

	try {
		await navigator.serviceWorker.register('./sw.js', { scope: './' });
		// `ready` resolves once a worker is active. Precaching happens atomically during install,
		// but we still confirm that the exact URLs this page needs are reachable from the cache.
		const registration = await navigator.serviceWorker.ready;
		const assets = [
			location.href,
			...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]')).map((node) => node.src),
			...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map((node) => node.href),
		];
		const hits = await Promise.all(assets.map((url) => caches.match(url, { ignoreVary: true })));
		if (registration.active && hits.every(Boolean)) {
			ui.offlineBadge.textContent = 'Offline: ready';
			ui.offlineBadge.className = 'pill pill-ok';
		} else {
			ui.offlineBadge.textContent = 'Offline: incomplete';
			ui.offlineBadge.className = 'pill pill-warn';
		}
	} catch {
		ui.offlineBadge.textContent = 'Offline: unavailable';
		ui.offlineBadge.className = 'pill pill-warn';
	}
};

applyTheme();
applySettingsToForm();
render();
reportCapabilities();
void registerServiceWorker();
void cleanupTemporaryOutputs();

/**
 * Small hook used by the automated browser test (and handy for debugging):
 * it feeds in-memory files through the exact same code path as the folder picker.
 */
(window as unknown as { autoVideoFusion: unknown }).autoVideoFusion = {
	addFiles: (files: File[]) => {
		directoryHandle = null;
		directoryLabel = 'test files';
		addFiles(files.map((file) => ({ file, path: file.name })));
	},
	applySettings: (patch: Partial<AppSettings>) => {
		Object.assign(settings, patch);
		applyTheme();
		applySettingsToForm();
		saveSettings(settings);
		render();
	},
	start: () => startMerge(),
	state: () => ({
		merging,
		entries: entries.map((entry) => ({
			path: entry.path,
			status: entry.status,
			note: entry.note,
			hasThumbnail: Boolean(entry.thumbnailUrl),
			// The thumbnail Blob is dropped so the state stays structured-clone friendly for tests.
			probe: entry.probe ? { ...entry.probe, thumbnail: null } : null,
		})),
	}),
};
