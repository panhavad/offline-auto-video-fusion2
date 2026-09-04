import { defineConfig, loadEnv } from 'vite';

const port = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
};

// Reads the real environment without pulling in @types/node just for this file.
const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// Ports live in .env (see .env.example) so they can be changed without touching
// tracked files. Variables from the actual environment — the ones Docker Compose
// injects — take precedence over the file.
export default defineConfig(({ mode }) => {
	const env = { ...loadEnv(mode, '.', ''), ...processEnv };

	return {
		// Relative base so the built app also works from a subfolder or from file-served static hosts.
		base: './',
		build: {
			target: 'es2022',
			sourcemap: false,
			assetsInlineLimit: 0,
		},
		worker: {
			format: 'es',
		},
		server: {
			port: port(env.DEV_PORT, 5173),
		},
		preview: {
			port: port(env.PREVIEW_PORT, 4173),
		},
	};
});
