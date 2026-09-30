import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const virtualId = 'virtual:app-version';
const resolvedVirtualId = `\0${virtualId}`;
const trackedPaths = [
	'index.html',
	'package.json',
	'package-lock.json',
	'public',
	'scripts',
	'src',
	'tsconfig.json',
	'vite.config.ts',
];

const filesIn = (path) => {
	const absolutePath = resolve(projectRoot, path);
	const entry = statSync(absolutePath);
	if (entry.isFile()) return [absolutePath];

	return readdirSync(absolutePath, { withFileTypes: true })
		.sort((left, right) => left.name.localeCompare(right.name))
		.flatMap((child) => filesIn(resolve(path, child.name)));
};

const isTrackedFile = (file) => {
	const projectPath = relative(projectRoot, file);
	return (
		projectPath !== '' &&
		!projectPath.startsWith(`..${sep}`) &&
		trackedPaths.some((path) => projectPath === path || projectPath.startsWith(`${path}${sep}`))
	);
};

const appVersion = () => {
	const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
	if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
		throw new Error('package.json must contain a non-empty version string.');
	}

	const hash = createHash('sha256');
	for (const file of trackedPaths.flatMap(filesIn).sort()) {
		hash.update(relative(projectRoot, file).split(sep).join('/'));
		hash.update('\0');
		hash.update(readFileSync(file));
		hash.update('\0');
	}

	return `${packageJson.version}+${hash.digest('hex').slice(0, 12)}`;
};

export const createVersionTrackerPlugin = () => ({
	name: 'app-version-tracker',
	resolveId(id) {
		return id === virtualId ? resolvedVirtualId : undefined;
	},
	load(id) {
		return id === resolvedVirtualId ? `export const APP_VERSION = ${JSON.stringify(appVersion())};` : undefined;
	},
	handleHotUpdate({ file, server }) {
		if (!isTrackedFile(file)) return;

		const versionModule = server.moduleGraph.getModuleById(resolvedVirtualId);
		if (!versionModule) return;

		server.moduleGraph.invalidateModule(versionModule);
		return [versionModule];
	},
});
