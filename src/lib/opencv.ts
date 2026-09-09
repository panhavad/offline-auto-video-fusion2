/**
 * Isolates the one dangerous thing about OpenCV.js: its module object is *thenable*.
 *
 * Emscripten attaches a `then` method so `await Module` can wait for the WASM runtime. That makes
 * the object poisonous to the promise machinery, which unwraps anything thenable a promise resolves
 * to - and here the unwrapping never terminates. `import('@techstark/opencv-js')` resolves its
 * promise with exactly that object (the bundler's CommonJS interop hands the module's exports
 * straight through), so the dynamic import never settles and the worker hangs forever, with no
 * error and no way to recover.
 *
 * A *static* import does not go through promise resolution, so this module can take the object,
 * strip `then` off it, and hand back something safe. Everything else imports this module instead,
 * and importing it dynamically still keeps the ~10 MB payload out of the initial download.
 */
import * as openCvNamespace from '@techstark/opencv-js';

export type OpenCvRuntime = typeof openCvNamespace & {
	/** Fired once the WASM runtime is usable; the only readiness signal that survives here. */
	onRuntimeInitialized?: () => void;
	calledRun?: boolean;
};

const runtime: OpenCvRuntime = (() => {
	const namespace = openCvNamespace as unknown as { default?: OpenCvRuntime };
	const module = (namespace.default ?? openCvNamespace) as OpenCvRuntime;
	delete (module as { then?: unknown }).then;
	return module;
})();

/** The raw OpenCV module. It is *not* ready to use until the WASM runtime has initialized. */
export const openCvRuntime = (): OpenCvRuntime => runtime;
