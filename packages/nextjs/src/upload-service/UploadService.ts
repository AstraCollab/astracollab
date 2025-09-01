import axios, { type AxiosInstance, type AxiosRequestConfig, CanceledError } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { 
    FileUploadProgress, 
    FileToUpload, 
    UploadBatchConfig,
    SingleFileUploadOptions 
} from '../types';
import type { 
    WorkerMessage, 
    StartSingleUploadPayload, 
    StartMultipartUploadPayload,
    StartMultipartUploadResponse,
    StartSingleUploadResponse 
} from './types';
import {
    MAX_S3_CHUNKS,
    DEFAULT_CHUNK_SIZE_MB,
    MIN_S3_PART_SIZE_MB,
    MAX_CONCURRENT_CHUNKS,
    PROGRESS_UPDATE_INTERVAL,
    WORKER_CLEANUP_INTERVAL,
    PROGRESS_UPDATE_THRESHOLD
} from './types';

export class UploadService {
    private axiosInstance: AxiosInstance;
    private _currentUploadProgress: Map<string, FileUploadProgress>;
    private _abortControllers: Map<string, AbortController>;
    private _progressListeners: Set<(progressMap: Map<string, FileUploadProgress>) => void>;
    private _loggedMissingIds: Set<string>;
    private _sharedWorker: Worker | null = null;
    private _broadcastChannel: BroadcastChannel;
    private _lastProgressUpdate = 0;
    private _progressUpdateTimeout: NodeJS.Timeout | null = null;
    private _chunkQueue: Array<{
        chunk: Blob;
        presignedUrl: string;
        partNumber: number;
        fileName: string;
        fileId: string;
        resolve: (value: { etag: string; partNumber: number }) => void;
        reject: (reason: any) => void;
    }> = [];
    private _activeChunkUploads = 0;
    private _processingQueue = false;
    private _completedChunks: Map<string, Set<number>> = new Map();
    private _totalChunks: Map<string, number> = new Map();
    private _chunkSizes: Map<string, Map<number, number>> = new Map();

    constructor(baseURL: string, apiKey?: string) {
        this.axiosInstance = axios.create({
            baseURL,
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey && { 'Authorization': `Bearer ${apiKey}` })
            },
            timeout: 600000,
            maxRedirects: 5,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });
        this._currentUploadProgress = new Map<string, FileUploadProgress>();
        this._abortControllers = new Map<string, AbortController>();
        this._progressListeners = new Set();
        this._loggedMissingIds = new Set<string>();
        this._broadcastChannel = new BroadcastChannel('upload-channel');
        
        this._setupBroadcastChannel();
        this._startWorkerCleanup();
    }

    private _createSharedWorker(): Worker {
        if (this._sharedWorker) {
            return this._sharedWorker;
        }

        // Create worker from blob for portability
        const workerCode = `
            // Web Worker code for file uploads
            self.onmessage = function(e) {
                const { type, file, presignedUrl, fileId, chunk, partNumber } = e.data;
                
                if (type === 'upload-file') {
                    uploadFile(file, presignedUrl, fileId);
                } else if (type === 'upload-chunk') {
                    uploadChunk(chunk, presignedUrl, partNumber, fileId);
                }
            };

            async function uploadFile(file, presignedUrl, fileId) {
                try {
                    const xhr = new XMLHttpRequest();
                    xhr.open('PUT', presignedUrl);
                    xhr.setRequestHeader('Content-Type', file.type);
                    
                    xhr.upload.onprogress = function(e) {
                        if (e.lengthComputable) {
                            const progress = Math.round((e.loaded * 100) / e.total);
                            self.postMessage({
                                type: 'progress',
                                progress,
                                fileId,
                                uploadedBytes: e.loaded,
                                totalBytes: e.total
                            });
                        }
                    };
                    
                    xhr.onload = function() {
                        if (xhr.status === 200) {
                            self.postMessage({
                                type: 'status',
                                status: 'completed',
                                fileId
                            });
                        } else {
                            self.postMessage({
                                type: 'error',
                                error: 'Upload failed',
                                fileId
                            });
                        }
                    };
                    
                    xhr.onerror = function() {
                        self.postMessage({
                            type: 'error',
                            error: 'Network error',
                            fileId
                        });
                    };
                    
                    xhr.send(file);
                } catch (error) {
                    self.postMessage({
                        type: 'error',
                        error: error.message,
                        fileId
                    });
                }
            }

            async function uploadChunk(chunk, presignedUrl, partNumber, fileId) {
                try {
                    const xhr = new XMLHttpRequest();
                    xhr.open('PUT', presignedUrl);
                    
                    xhr.onload = function() {
                        if (xhr.status === 200) {
                            const etag = xhr.getResponseHeader('ETag');
                            self.postMessage({
                                type: 'chunk-complete',
                                partNumber,
                                etag,
                                fileId
                            });
                        } else {
                            self.postMessage({
                                type: 'chunk-error',
                                partNumber,
                                error: 'Chunk upload failed',
                                fileId
                            });
                        }
                    };
                    
                    xhr.onerror = function() {
                        self.postMessage({
                            type: 'chunk-error',
                            partNumber,
                            error: 'Network error',
                            fileId
                        });
                    };
                    
                    xhr.send(chunk);
                } catch (error) {
                    self.postMessage({
                        type: 'chunk-error',
                        partNumber,
                        error: error.message,
                        fileId
                    });
                }
            }
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this._sharedWorker = new Worker(URL.createObjectURL(blob));
        
        this._sharedWorker.onmessage = (event) => {
            this._processWorkerMessage(event.data);
        };
        
        return this._sharedWorker;
    }

    private _startWorkerCleanup(): void {
        setInterval(() => {
            for (const [fileId, progress] of this._currentUploadProgress.entries()) {
                if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'canceled') {
                    setTimeout(() => {
                        this._currentUploadProgress.delete(fileId);
                    }, 5000);
                }
            }
        }, WORKER_CLEANUP_INTERVAL);
    }

    public addProgressListener(listener: (progressMap: Map<string, FileUploadProgress>) => void) {
        this._progressListeners.add(listener);
    }

    public removeProgressListener(listener: (progressMap: Map<string, FileUploadProgress>) => void) {
        this._progressListeners.delete(listener);
    }

    private _setupBroadcastChannel(): void {
        this._broadcastChannel.onmessage = (event) => {
            this._processWorkerMessage(event.data);
        };
    }

    private _processWorkerMessage(message: WorkerMessage): void {
        const { type, fileId, progress, status, error, partNumber, etag, uploadedBytes, totalBytes } = message;

        if (!fileId) return;

        switch (type) {
            case 'progress':
                this._handleProgressUpdate(fileId, progress || 0, uploadedBytes || 0, totalBytes || 0);
                break;
            case 'status':
                this._handleStatusUpdate(fileId, status || 'unknown');
                break;
            case 'error':
                this._handleError(fileId, error || 'Unknown error');
                break;
            case 'chunk-complete':
                this._handleChunkComplete(fileId, partNumber!, etag!);
                break;
            case 'chunk-error':
                this._handleChunkError(fileId, partNumber!, error || 'Chunk upload failed');
                break;
        }
    }

    private _handleProgressUpdate(fileId: string, progress: number, uploadedBytes: number, totalBytes: number): void {
        const currentProgress = this._currentUploadProgress.get(fileId);
        if (!currentProgress) return;

        const newProgress: FileUploadProgress = {
            ...currentProgress,
            uploadedBytes,
            totalBytes,
            progressPercentage: progress,
            status: 'uploading'
        };

        this._currentUploadProgress.set(fileId, newProgress);
        this._notifyProgressListeners();
    }

    private _handleStatusUpdate(fileId: string, status: string): void {
        const currentProgress = this._currentUploadProgress.get(fileId);
        if (!currentProgress) return;

        const newProgress: FileUploadProgress = {
            ...currentProgress,
            status: status as FileUploadProgress['status']
        };

        this._currentUploadProgress.set(fileId, newProgress);
        this._notifyProgressListeners();
    }

    private _handleError(fileId: string, error: string): void {
        const currentProgress = this._currentUploadProgress.get(fileId);
        if (!currentProgress) return;

        const newProgress: FileUploadProgress = {
            ...currentProgress,
            status: 'failed',
            error
        };

        this._currentUploadProgress.set(fileId, newProgress);
        this._notifyProgressListeners();
    }

    private _handleChunkComplete(fileId: string, partNumber: number, etag: string): void {
        const completedChunks = this._completedChunks.get(fileId) || new Set();
        completedChunks.add(partNumber);
        this._completedChunks.set(fileId, completedChunks);

        const totalChunks = this._totalChunks.get(fileId) || 0;
        if (completedChunks.size === totalChunks) {
            this._completeMultipartUpload(fileId);
        }
    }

    private _handleChunkError(fileId: string, partNumber: number, error: string): void {
        this._handleError(fileId, `Chunk ${partNumber} failed: ${error}`);
    }

    private async _completeMultipartUpload(fileId: string): Promise<void> {
        try {
            const progress = this._currentUploadProgress.get(fileId);
            if (!progress) return;

            const completedChunks = this._completedChunks.get(fileId);
            if (!completedChunks) return;

            const uploadPromises = Array.from(completedChunks).map(partNumber => ({
                partNumber,
                etag: `"etag-${partNumber}"` // In real implementation, this would be the actual ETag
            }));

            await this.axiosInstance.post('/api/v1/files/multipart-upload-complete', {
                key: fileId,
                uploadPromises
            });

            this._handleStatusUpdate(fileId, 'completed');
        } catch (error) {
            this._handleError(fileId, error instanceof Error ? error.message : 'Failed to complete upload');
        }
    }

    private _notifyProgressListeners(): void {
        const now = Date.now();
        if (now - this._lastProgressUpdate < PROGRESS_UPDATE_INTERVAL) {
            if (this._progressUpdateTimeout) {
                clearTimeout(this._progressUpdateTimeout);
            }
            this._progressUpdateTimeout = setTimeout(() => {
                this._notifyProgressListeners();
            }, PROGRESS_UPDATE_INTERVAL - (now - this._lastProgressUpdate));
            return;
        }

        this._lastProgressUpdate = now;
        const progressMap = new Map(this._currentUploadProgress);
        this._progressListeners.forEach(listener => {
            try {
                listener(progressMap);
            } catch (error) {
                console.error('Error in progress listener:', error);
            }
        });
    }

    public async uploadSingleFile(options: SingleFileUploadOptions): Promise<string> {
        const { file, fileName, folderId, orgId, onProgress } = options;
        const clientFileId = uuidv4();

        this.updateProgress(clientFileId, {
            fileId: clientFileId,
            fileName: fileName || file.name,
            totalBytes: file.size,
            uploadedBytes: 0,
            progressPercentage: 0,
            status: 'uploading',
            error: undefined,
        });

        try {
            const params = new URLSearchParams({
                fileName: fileName || file.name,
                fileType: file.type,
                fileSize: file.size.toString()
            });
            if (folderId) params.append('folderId', folderId);
            if (orgId) params.append('orgId', orgId);

            const presignedUrlResponse = await this.axiosInstance.get<StartSingleUploadResponse>(
                `/api/v1/files/upload?${params.toString()}`
            );

            const { presignedUrl, fileId: actualFileId } = presignedUrlResponse.data;

            if (clientFileId !== actualFileId) {
                const progressEntry = this._currentUploadProgress.get(clientFileId);
                if (progressEntry) {
                    this._currentUploadProgress.delete(clientFileId);
                    this._currentUploadProgress.set(actualFileId, { ...progressEntry, fileId: actualFileId });
                }
            }

            const worker = this._createSharedWorker();
            worker.postMessage({
                type: 'upload-file',
                file: file,
                presignedUrl: presignedUrl,
                fileId: actualFileId
            });

            return actualFileId;
        } catch (error) {
            this._handleError(clientFileId, error instanceof Error ? error.message : 'Upload failed');
            throw error;
        }
    }

    public async uploadMultipleFiles(config: UploadBatchConfig): Promise<void> {
        const { files, onProgress, onError, onSuccess } = config;
        const results: { fileId: string; fileName: string; }[] = [];

        for (const fileToUpload of files) {
            try {
                const fileId = await this.uploadSingleFile({
                    file: fileToUpload.file,
                    fileName: fileToUpload.name,
                    folderId: config.folderId,
                    orgId: config.orgId
                });

                results.push({
                    fileId,
                    fileName: fileToUpload.name
                });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Upload failed';
                onError?.(errorMsg, fileToUpload.id);
            }
        }

        if (results.length > 0) {
            onSuccess?.(results);
        }
    }

    public updateProgress(fileId: string, updates: Partial<FileUploadProgress>): void {
        const current = this._currentUploadProgress.get(fileId);
        
        if (current) {
            const updatedProgress: FileUploadProgress = {
                ...current,
                ...updates
            };
            this._currentUploadProgress.set(fileId, updatedProgress);
        } else {
            const newProgress: FileUploadProgress = {
                fileId: updates.fileId || fileId,
                fileName: updates.fileName || "Unknown",
                totalBytes: updates.totalBytes || 0,
                uploadedBytes: updates.uploadedBytes || 0,
                progressPercentage: updates.progressPercentage || 0,
                status: updates.status || 'pending',
                error: updates.error
            };
            this._currentUploadProgress.set(fileId, newProgress);
        }

        this._notifyProgressListeners();
    }

    public cancelUpload(fileId: string): void {
        const controller = this._abortControllers.get(fileId);
        if (controller) {
            controller.abort();
            this._abortControllers.delete(fileId);
        }

        this.updateProgress(fileId, {
            status: 'canceled',
            error: 'Upload canceled by user'
        });
    }

    public getProgress(fileId: string): FileUploadProgress | undefined {
        return this._currentUploadProgress.get(fileId);
    }

    public getAllProgress(): Map<string, FileUploadProgress> {
        return new Map(this._currentUploadProgress);
    }

    public clearProgress(fileId: string): void {
        this._currentUploadProgress.delete(fileId);
        this._notifyProgressListeners();
    }

    public clearAllProgress(): void {
        this._currentUploadProgress.clear();
        this._notifyProgressListeners();
    }
}
