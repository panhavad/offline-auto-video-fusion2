import { defineConfig } from 'vite';

export default defineConfig({
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
		port: 5173,
	},
	preview: {
		port: 4173,
	},
});
