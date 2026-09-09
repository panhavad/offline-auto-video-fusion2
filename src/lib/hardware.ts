/**
 * Detects what the current machine can actually do and turns that into a concrete pipeline plan.
 *
 * The merge pipeline has three stages that can run at the same time - decoding, compositing and
 * encoding - and each of them is hardware accelerated on machines with a real GPU. A single
 * sequential loop leaves most of that hardware idle, so the plan below decides how many clips may
 * be decoded and composited ahead of the encoder, and how many finished frames may be buffered.
 *
 * Everything is bounded: the look-ahead is expressed as a *memory budget* rather than a frame count,
 * so a 4K merge on a small laptop keeps the same footprint as a 720p merge on a workstation.
 */

import type { AccelerationMode } from '../types';

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';
export interface HardwareProfile {
	/** Logical CPU cores, as reported by the browser (already clamped to something sane). */
	cores: number;
	/** Rough system memory in GB, or null when the browser does not report it. */
	memoryGb: number | null;
	/** Human readable GPU name, or null when nothing could be detected. */
	gpu: string | null;
	vendor: GpuVendor;
	/** True for dedicated GPUs (GeForce/Radeon/Arc) - those tolerate much deeper pipelining. */
	discrete: boolean;
	/** Whether a WebGPU adapter was found; a good proxy for "modern GPU stack is alive". */
	webgpu: boolean;
}

export interface PipelinePlan {
	/** Concurrent decode + composite lanes running ahead of the encoder. */
	renderThreads: number;
	/** Composited frames a single lane may run ahead of the encoder. */
	frameQueueDepth: number;
	/** Decoded audio chunks a single lane may run ahead of the encoder. */
	audioQueueDepth: number;
	/** Whether decoders and encoders should be asked for hardware acceleration explicitly. */
	preferHardware: boolean;
	/** Approximate upper bound of the frame buffers held in flight, for logging. */
	frameBudgetBytes: number;
}

const DEFAULT_CORES = 4;
const MIN_FRAME_QUEUE = 3;
/**
 * The encoder only keeps four frames in its own queue, so a handful of finished frames per lane is
 * all it takes to never let it go idle. Anything beyond that just parks GPU memory.
 */
const MAX_FRAME_QUEUE = 8;
const MAX_FRAME_BUDGET_BYTES = 768 * 1024 * 1024;
const AUDIO_QUEUE_DEPTH = 96;

interface AdapterInfoLike {
	vendor?: string;
	architecture?: string;
	device?: string;
	description?: string;
}

interface AdapterLike {
	info?: AdapterInfoLike;
	requestAdapterInfo?: () => Promise<AdapterInfoLike>;
}

interface GpuLike {
	requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<AdapterLike | null>;
}

const navigatorWith = <T>(key: string): T | undefined =>
	(navigator as unknown as Record<string, T | undefined>)[key];

/** Classifies a renderer/adapter string such as "NVIDIA GeForce RTX 4070 Laptop GPU". */
export const classifyGpu = (text: string): { vendor: GpuVendor; discrete: boolean } => {
	const value = text.toLowerCase();
	if (/nvidia|geforce|rtx|gtx|quadro|tesla|nvs /.test(value)) return { vendor: 'nvidia', discrete: true };
	if (/apple/.test(value)) return { vendor: 'apple', discrete: false };
	if (/amd|radeon|firepro|vega/.test(value)) {
		// Dedicated Radeons carry an RX/Pro/FirePro model; APUs are named "Radeon 780M Graphics",
		// "Radeon(TM) Graphics" or "Radeon Vega 8 Graphics" and share system memory with the CPU.
		const dedicated = /\brx\s?\d|radeon pro|firepro|instinct|\bw\d{4}\b/.test(value);
		return { vendor: 'amd', discrete: dedicated };
	}
	if (/intel|iris|uhd graphics|hd graphics|arc/.test(value)) {
		// Only the discrete Arc cards (A380, B580, ...) are separate GPUs; "Arc(TM) Graphics" is an iGPU.
		return { vendor: 'intel', discrete: /\barc\b[^,]*\b[ab]\d{3}\b/.test(value) };
	}
	return { vendor: 'unknown', discrete: false };
};

/** Reads the unmasked GL renderer string, which is the most descriptive GPU name available. */
const webglRenderer = (): string | null => {
	try {
		const canvas =
			typeof OffscreenCanvas !== 'undefined'
				? new OffscreenCanvas(1, 1)
				: typeof document !== 'undefined'
					? document.createElement('canvas')
					: null;
		if (!canvas) return null;
		const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
		if (!gl) return null;
		const debug = gl.getExtension('WEBGL_debug_renderer_info');
		const renderer = debug
			? (gl.getParameter((debug as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL) as string)
			: (gl.getParameter(gl.RENDERER) as string);
		gl.getExtension('WEBGL_lose_context')?.loseContext();
		return typeof renderer === 'string' && renderer.trim() ? renderer.trim() : null;
	} catch {
		return null;
	}
};

let cachedProfile: Promise<HardwareProfile> | null = null;

/** Detects CPU/GPU capabilities once per thread; the result is cached. */
export const detectHardware = (): Promise<HardwareProfile> => {
	cachedProfile ??= (async (): Promise<HardwareProfile> => {
		const rawCores = Number(navigator.hardwareConcurrency);
		const cores = Number.isFinite(rawCores) && rawCores > 0 ? Math.min(64, Math.round(rawCores)) : DEFAULT_CORES;
		const rawMemory = Number(navigatorWith<number>('deviceMemory'));
		const memoryGb = Number.isFinite(rawMemory) && rawMemory > 0 ? rawMemory : null;

		let gpu: string | null = null;
		let webgpu = false;

		const gpuApi = navigatorWith<GpuLike>('gpu');
		if (gpuApi) {
			try {
				const adapter = await gpuApi.requestAdapter({ powerPreference: 'high-performance' });
				if (adapter) {
					webgpu = true;
					const info = adapter.info ?? (await adapter.requestAdapterInfo?.().catch(() => undefined));
					const parts = [info?.description, info?.vendor, info?.architecture, info?.device]
						.filter((part): part is string => Boolean(part && part.trim()));
					if (parts.length > 0) gpu = parts.join(' ');
				}
			} catch {
				/* WebGPU unavailable or blocked - fall back to WebGL below */
			}
		}

		const renderer = webglRenderer();
		// The GL renderer string is usually far more specific than the WebGPU adapter info.
		if (renderer && (!gpu || renderer.length > gpu.length)) gpu = renderer;

		const { vendor, discrete } = classifyGpu(gpu ?? '');
		return { cores, memoryGb, gpu, vendor, discrete, webgpu };
	})();
	return cachedProfile;
};

const clamp = (value: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, Math.floor(value)));

/**
 * Turns a hardware profile into a concrete pipeline plan for one merge.
 *
 * The lanes are concurrent decode/composite pipelines, not OS threads: the browser already runs each
 * decoder and the encoder on its own thread, and the lanes are what keep all of them fed at once.
 * More lanes therefore means more simultaneous decoder sessions and more frames in flight, which is
 * why the count is capped by both the core count and the memory budget.
 *
 * `safe` keeps the old strictly sequential behaviour, `auto` scales with the machine, and `max`
 * pushes as far as the hardware sensibly allows while still leaving room for the encoder and the UI.
 */
export const planPipeline = (
	profile: HardwareProfile,
	options: { clips: number; width: number; height: number; mode: AccelerationMode; preferHardware: boolean },
): PipelinePlan => {
	const { clips, width, height, mode } = options;
	const cores = profile.cores;

	let threads: number;
	if (mode === 'safe') {
		threads = 1;
	} else if (mode === 'balanced') {
		threads = clamp(cores / 4, 1, 2);
	} else if (mode === 'max') {
		threads = clamp(cores / 2, 2, 8);
	} else {
		// A dedicated GPU has its own decoder blocks and its own memory, so it takes more lanes than
		// an integrated one, where every extra decoder session competes for the same memory bandwidth.
		threads = profile.discrete ? clamp(cores / 3, 2, 6) : clamp(cores / 4, 2, 4);
	}

	// Memory is the one resource that actually takes a machine down, so it caps the lane count too.
	if (profile.memoryGb !== null) {
		threads = Math.min(threads, Math.max(1, Math.floor(profile.memoryGb / 2)));
	}
	threads = Math.max(1, Math.min(threads, clips));

	// A composited frame lives as NV12/I420 in GPU or shared memory: 1.5 bytes per pixel.
	const frameBytes = Math.max(1, width * height * 1.5);
	const systemBudget = (profile.memoryGb ?? 8) * 1024 * 1024 * 1024 * 0.12;
	const frameBudgetBytes = Math.min(MAX_FRAME_BUDGET_BYTES, systemBudget);
	const depth =
		mode === 'safe'
			? MIN_FRAME_QUEUE
			: clamp(frameBudgetBytes / (frameBytes * threads), MIN_FRAME_QUEUE, MAX_FRAME_QUEUE);

	return {
		renderThreads: threads,
		frameQueueDepth: depth,
		audioQueueDepth: AUDIO_QUEUE_DEPTH,
		preferHardware: options.preferHardware && mode !== 'safe',
		frameBudgetBytes: Math.round(frameBytes * depth * threads),
	};
};

export const describeHardware = (profile: HardwareProfile): string => {
	const gpu = profile.gpu ?? 'unknown GPU';
	const kind = profile.discrete ? 'dedicated' : profile.vendor === 'unknown' ? 'unrecognised' : 'integrated';
	const memory = profile.memoryGb ? `, ~${profile.memoryGb} GB RAM` : '';
	return `${gpu} (${kind}), ${profile.cores} logical cores${memory}`;
};

export const describePlan = (plan: PipelinePlan): string =>
	`${plan.renderThreads} decode/compose lane${plan.renderThreads === 1 ? '' : 's'}` +
	` · ${plan.frameQueueDepth} frame look-ahead each` +
	` · ≤ ${Math.max(1, Math.round(plan.frameBudgetBytes / (1024 * 1024)))} MB of frame buffers` +
	`${plan.preferHardware ? ' · hardware codecs preferred' : ' · codec choice left to the browser'}`;
