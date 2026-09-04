export {};

declare global {
	interface FilePickerAcceptType {
		description?: string;
		accept: Record<string, string[]>;
	}

	interface SaveFilePickerOptions {
		id?: string;
		suggestedName?: string;
		types?: FilePickerAcceptType[];
		startIn?: FileSystemHandle | string;
	}

	interface DirectoryPickerOptions {
		id?: string;
		mode?: 'read' | 'readwrite';
		startIn?: FileSystemHandle | string;
	}

	interface Window {
		showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
		showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
	}

	interface FileSystemHandle {
		queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
		requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
	}
}
