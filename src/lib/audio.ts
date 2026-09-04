import { AudioSample } from 'mediabunny';

/** Canonical audio layout every sample is converted to before it reaches the encoder. */
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;

/**
 * Source clips may use any channel layout and sample rate, but an encoder is configured once from
 * the first sample it receives and then rejects anything shaped differently ("Audio parameters must
 * remain constant. Expected 1 channels at 48000 Hz, got 2 channels at 48000 Hz").
 *
 * Mediabunny's own `transform` option cannot prevent that, because the constant-parameter check runs
 * *before* the transform is applied. So every sample is converted to one canonical layout
 * (48 kHz stereo) up front, which makes the channel layout of the input files irrelevant.
 */
export class AudioNormalizer {
	/** Fractional read position carried into the next buffer so resampling stays continuous. */
	private phase = 0;
	/** Trailing source frames of the previous buffer, needed to interpolate across the seam. */
	private tail: Float32Array[] | null = null;

	/** Called between clips; each clip is resampled independently. */
	reset(): void {
		this.phase = 0;
		this.tail = null;
	}

	/** Extracts each channel of a sample as planar float data. */
	private static planes(sample: AudioSample): Float32Array[] {
		const planes: Float32Array[] = [];
		for (let channel = 0; channel < sample.numberOfChannels; channel++) {
			const plane = new Float32Array(sample.numberOfFrames);
			sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
			planes.push(plane);
		}
		return planes;
	}

	/** Folds an arbitrary channel layout down to plain stereo. */
	private static toStereo(planes: Float32Array[]): Float32Array[] {
		if (planes.length === 0) return [new Float32Array(0), new Float32Array(0)];
		if (planes.length === 1) return [planes[0], planes[0]];
		return [planes[0], planes[1]];
	}

	/** Builds a canonical planar stereo sample from per-channel data. */
	private static pack(channels: Float32Array[], frames: number, timestamp: number): AudioSample {
		const data = new Float32Array(frames * AUDIO_CHANNELS);
		data.set(channels[0].subarray(0, frames), 0);
		data.set(channels[1].subarray(0, frames), frames);
		return new AudioSample({
			data,
			format: 'f32-planar',
			numberOfChannels: AUDIO_CHANNELS,
			sampleRate: AUDIO_SAMPLE_RATE,
			timestamp,
		});
	}

	/**
	 * Returns the sample in canonical form. The returned sample is the input itself when it already
	 * matches, so callers must only close the result separately when it differs from the input.
	 */
	convert(sample: AudioSample): AudioSample {
		// Fast path: already canonical, so no conversion (and no quality loss) at all.
		if (sample.numberOfChannels === AUDIO_CHANNELS && sample.sampleRate === AUDIO_SAMPLE_RATE) {
			return sample;
		}

		const stereo = AudioNormalizer.toStereo(AudioNormalizer.planes(sample));

		if (sample.sampleRate === AUDIO_SAMPLE_RATE) {
			return AudioNormalizer.pack(stereo, sample.numberOfFrames, sample.timestamp);
		}

		// Join the previous buffer's tail so interpolation has data on both sides of the seam.
		const carry = this.tail;
		const carryFrames = carry ? carry[0].length : 0;
		const sourceFrames = carryFrames + sample.numberOfFrames;
		const source = stereo.map((plane, channel) => {
			const joined = new Float32Array(sourceFrames);
			if (carry) joined.set(carry[channel], 0);
			joined.set(plane, carryFrames);
			return joined;
		});

		const ratio = sample.sampleRate / AUDIO_SAMPLE_RATE;
		const outputFrames =
			sourceFrames < 2 ? 0 : Math.max(0, Math.floor((sourceFrames - 1 - this.phase) / ratio) + 1);

		const output = [new Float32Array(outputFrames), new Float32Array(outputFrames)];
		for (let frame = 0; frame < outputFrames; frame++) {
			const position = this.phase + frame * ratio;
			const index = Math.floor(position);
			const fraction = position - index;
			for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
				const current = source[channel][index];
				const next = source[channel][index + 1] ?? current;
				output[channel][frame] = current + (next - current) * fraction;
			}
		}

		// Keep whatever could not be consumed yet for the next buffer.
		const consumed = this.phase + outputFrames * ratio;
		const keepFrom = Math.min(Math.floor(consumed), sourceFrames);
		this.phase = consumed - keepFrom;
		this.tail = source.map((plane) => plane.slice(keepFrom));

		const startedAt = sample.timestamp - carryFrames / sample.sampleRate;
		return AudioNormalizer.pack(output, outputFrames, startedAt);
	}

	/** Creates a canonical chunk of silence of the given length. */
	static silence(timestamp: number, frames: number): AudioSample {
		return new AudioSample({
			data: new Float32Array(frames * AUDIO_CHANNELS),
			format: 'f32-planar',
			numberOfChannels: AUDIO_CHANNELS,
			sampleRate: AUDIO_SAMPLE_RATE,
			timestamp,
		});
	}
}
