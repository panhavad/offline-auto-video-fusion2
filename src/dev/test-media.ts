/**
 * Test fixture helper - generates small in-memory video files with mediabunny.
 *
 * This module is only loaded on demand (e.g. `import('/src/dev/test-media.ts')` from the dev
 * server console or an automated browser test) and is never referenced by the app bundle.
 */
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	CanvasSource,
	Input,
	Mp4OutputFormat,
	Output,
	QUALITY_LOW,
	VideoSampleSink,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	type AudioCodec,
	type VideoCodec,
} from 'mediabunny';

/** Re-exported so browser tests can drive mediabunny directly from the page. */
export * as mediabunny from 'mediabunny';

export interface TestVideoOptions {
	name: string;
	width: number;
	height: number;
	seconds: number;
	frameRate?: number;
	color?: string;
	withAudio?: boolean;
	/** Channel count of the generated audio track (1 = mono, 2 = stereo). */
	audioChannels?: number;
	/** Sample rate of the generated audio track in hertz. */
	audioSampleRate?: number;
	/** Forces a specific audio codec for the generated track. */
	audioCodec?: AudioCodec;
}

export async function makeTestVideo(options: TestVideoOptions): Promise<File> {
	const { name, width, height, seconds } = options;
	const frameRate = options.frameRate ?? 30;
	const color = options.color ?? '#204060';

	const videoCodec: VideoCodec | null = await getFirstEncodableVideoCodec(['avc', 'hevc', 'av1', 'vp9'], {
		width,
		height,
		quality: QUALITY_LOW,
	});
	if (!videoCodec) throw new Error('No encodable video codec in this browser');

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('No 2D context');

	const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_LOW });
	output.addVideoTrack(videoSource);

	let audioSource: AudioSampleSource | null = null;
	const audioChannels = options.audioChannels ?? 2;
	const audioSampleRate = options.audioSampleRate ?? 48000;
	if (options.withAudio) {
		const audioCodec: AudioCodec | null = options.audioCodec
			?? (await getFirstEncodableAudioCodec(['aac', 'opus'], {
				numberOfChannels: audioChannels,
				sampleRate: audioSampleRate,
			}));
		if (audioCodec) {
			audioSource = new AudioSampleSource({ codec: audioCodec, quality: QUALITY_LOW });
			output.addAudioTrack(audioSource);
		}
	}

	await output.start();

	const frames = Math.round(seconds * frameRate);
	for (let index = 0; index < frames; index++) {
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = '#ffffff';
		ctx.font = `${Math.round(height / 6)}px sans-serif`;
		ctx.fillText(`${name} ${index}`, 12, Math.round(height / 2));
		await videoSource.add(index / frameRate, 1 / frameRate);
	}

	if (audioSource) {
		const chunkSeconds = 0.5;
		for (let time = 0; time < seconds; time += chunkSeconds) {
			const frameCount = Math.round(Math.min(chunkSeconds, seconds - time) * audioSampleRate);
			const data = new Float32Array(frameCount * audioChannels);
			for (let i = 0; i < frameCount; i++) {
				const value = Math.sin(2 * Math.PI * 440 * (time + i / audioSampleRate)) * 0.2;
				for (let channel = 0; channel < audioChannels; channel++) {
					data[channel * frameCount + i] = value;
				}
			}
			const sample = new AudioSample({
				data,
				format: 'f32-planar',
				numberOfChannels: audioChannels,
				sampleRate: audioSampleRate,
				timestamp: time,
			});
			await audioSource.add(sample);
			sample.close();
		}
	}

	await output.finalize();
	const buffer = output.target.buffer;
	if (!buffer) throw new Error('Encoding produced no data');
	return new File([buffer], name, { type: 'video/mp4', lastModified: Date.now() });
}

export interface InspectionResult {
	duration: number;
	width: number;
	height: number;
	videoCodec: string | null;
	audioCodec: string | null;
	audioChannels: number | null;
	audioSampleRate: number | null;
	frameCount: number;
	firstTimestamp: number;
	lastTimestamp: number;
	audioDuration: number;
}

/** Reads a produced file back and reports what actually ended up inside it. */
export async function inspectVideo(blob: Blob): Promise<InspectionResult> {
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) throw new Error('No video track in the produced file');
	const audioTrack = await input.getPrimaryAudioTrack();

	let frameCount = 0;
	let firstTimestamp = Infinity;
	let lastTimestamp = 0;
	const sink = new VideoSampleSink(videoTrack);
	for await (const sample of sink.samples()) {
		frameCount++;
		firstTimestamp = Math.min(firstTimestamp, sample.timestamp);
		lastTimestamp = Math.max(lastTimestamp, sample.timestamp);
		sample.close();
	}

	return {
		duration: await input.computeDuration(),
		width: await videoTrack.getDisplayWidth(),
		height: await videoTrack.getDisplayHeight(),
		videoCodec: await videoTrack.getCodec(),
		audioCodec: audioTrack ? await audioTrack.getCodec() : null,
		audioChannels: audioTrack ? audioTrack.numberOfChannels : null,
		audioSampleRate: audioTrack ? audioTrack.sampleRate : null,
		frameCount,
		firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : 0,
		lastTimestamp,
		audioDuration: audioTrack ? await audioTrack.computeDuration() : 0,
	};
}
