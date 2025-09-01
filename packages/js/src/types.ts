export interface AstraCollabConfig {
	apiKey: string;
	baseURL?: string;
	timeout?: number;
}

export interface FileRecord {
	id: string;
	name: string;
	size: string;
	type: string;
	uploadedAt: string;
	folderId?: string;
	key?: string;
}

export interface Folder {
	id: string;
	name: string;
	parentFolderId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ApiKey {
	id: string;
	name: string;
	createdAt: string;
	lastUsed?: string;
}

export interface UploadFileOptions {
	file: globalThis.File | Blob;
	fileName?: string;
	folderId?: string;
	orgId?: string;
	onProgress?: (progress: number) => void;
}

export interface CreateFolderOptions {
	name: string;
	parentFolderId?: string;
}

export interface CreateApiKeyOptions {
	name: string;
}

export interface BillingInfo {
	subscription: {
		plan: string;
		status: string;
		includedStorageGB: number;
		additionalStorageGB: number;
		currentUsageGB: number;
		overageGB: number;
		filesCount: number;
		monthlyCost: {
			base: number;
			overage: number;
			total: number;
		};
	};
	usageHistory: Array<{
		period: string;
		filesCount: number;
		storageGB: number;
	}>;
}

export interface ApiResponse<T = any> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: any;
	};
}

export interface MultipartUploadStartOptions {
	fileName: string;
	fileType: string;
	fileSize: number;
	totalChunks: number;
	folderId?: string;
}

export interface MultipartUploadStartResponse {
	uploadId: string;
	fileId: string;
	presignedUrls: Array<{
		url: string;
		partNumber: number;
	}>;
	key: string;
}

export interface MultipartUploadCompleteOptions {
	uploadId: string;
	key: string;
	parts: Array<{
		etag: string;
		partNumber: number;
	}>;
	fileId: string;
}

export class AstraCollabError extends Error {
	constructor(
		message: string,
		public status?: number,
		public code?: string,
		public details?: any
	) {
		super(message);
		this.name = 'AstraCollabError';
	}
}
