// Core types for the upload service
export interface FileUploadProgress {
    fileId: string;
    fileName: string;
    totalBytes: number;
    uploadedBytes: number;
    progressPercentage: number;
    status: 'pending' | 'uploading' | 'completed' | 'failed' | 'canceled';
    error?: string;
}

export interface FileToUpload {
    id: string;
    file: File;
    name: string;
    size: number;
}

// Callbacks for the upload process
export interface UploadCallbacks {
    onProgress: (progressMap: Map<string, FileUploadProgress>) => void;
    onError: (errorMsg: string, fileId: string) => void;
    onSuccess: (results: { fileId: string; fileName: string; }[]) => void;
}

// Configuration for a batch upload
export interface UploadBatchConfig extends UploadCallbacks {
    files: FileToUpload[];
    folderId?: string;
    orgId?: string;
    chunkSize?: number;
    maxConcurrentFiles?: number;
    maxConcurrentChunks?: number;
    retryAttempts?: number;
}

// Single file upload options
export interface SingleFileUploadOptions {
    file: File;
    fileName?: string;
    folderId?: string;
    orgId?: string;
    onProgress?: (progress: number) => void;
}

// Upload service configuration
export interface UploadServiceConfig {
    baseURL: string;
    apiKey?: string;
    timeout?: number;
}

// Component props
export interface FileUploaderProps {
    config: UploadServiceConfig;
    folderId?: string;
    orgId?: string;
    maxFiles?: number;
    onUploadComplete?: (results: { fileId: string; fileName: string; }[]) => void;
    onUploadError?: (error: string, fileId: string) => void;
    onUploadProgress?: (progressMap: Map<string, FileUploadProgress>) => void;
    className?: string;
    children?: React.ReactNode;
}

// Hook return types
export interface UseUploadReturn {
    uploadFiles: (files: File[]) => Promise<void>;
    uploadProgress: Map<string, FileUploadProgress>;
    isUploading: boolean;
    cancelUpload: (fileId: string) => void;
    clearProgress: () => void;
}

export interface UseFilesReturn {
    files: any[];
    isLoading: boolean;
    error: Error | null;
    refetch: () => void;
}
