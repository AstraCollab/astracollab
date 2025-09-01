// Web Worker message types
export interface WorkerMessage {
    type: 'progress' | 'status' | 'ready' | 'error' | 'chunk-progress' | 'chunk-complete' | 'chunk-error';
    progress?: number;
    status?: string;
    fileName?: string;
    error?: string;
    retry?: boolean;
    partNumber?: number;
    etag?: string;
    progressPercent?: number;
    uploadedBytes?: number;
    totalBytes?: number;
    fileId?: string;
}

export interface StartSingleUploadPayload {
    fileName: string;
    fileType: string;
    fileSize: number;
    folderId?: string;
    orgId?: string;
}

export interface StartMultipartUploadPayload {
    fileName: string;
    fileType: string;
    fileSize: number;
    totalChunks: number;
    folderId?: string;
    orgId?: string;
}

export interface StartMultipartUploadResponse {
    uploadId: string;
    fileId: string;
    presignedUrls: Array<{ partNumber: number; url: string }>;
    key: string;
}

export interface StartSingleUploadResponse {
    fileId: string;
    presignedUrl: string;
}

// Constants
export const MAX_S3_CHUNKS = 10000;
export const DEFAULT_CHUNK_SIZE_MB = 15;
export const MIN_S3_PART_SIZE_MB = 5;
export const MAX_CONCURRENT_CHUNKS = 3;
export const PROGRESS_UPDATE_INTERVAL = 500;
export const WORKER_CLEANUP_INTERVAL = 30000;
export const PROGRESS_UPDATE_THRESHOLD = 1;
