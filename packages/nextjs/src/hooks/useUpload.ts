import { useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { FileUploadProgress, FileToUpload, UseUploadReturn } from '../types';
import { UploadService } from '../upload-service/UploadService';

export function useUpload(uploadService: UploadService): UseUploadReturn {
    const [uploadProgress, setUploadProgress] = useState<Map<string, FileUploadProgress>>(new Map());
    const [isUploading, setIsUploading] = useState(false);

    useEffect(() => {
        const handleProgressUpdate = (progressMap: Map<string, FileUploadProgress>) => {
            setUploadProgress(new Map(progressMap));
        };

        uploadService.addProgressListener(handleProgressUpdate);

        return () => {
            uploadService.removeProgressListener(handleProgressUpdate);
        };
    }, [uploadService]);

    const uploadFiles = useCallback(async (files: File[]) => {
        if (files.length === 0) return;

        setIsUploading(true);

        try {
            const filesToUpload: FileToUpload[] = files.map(file => ({
                id: uuidv4(),
                file,
                name: file.name,
                size: file.size
            }));

            await uploadService.uploadMultipleFiles({
                files: filesToUpload,
                onProgress: (progressMap) => {
                    setUploadProgress(new Map(progressMap));
                },
                onError: (errorMsg, fileId) => {
                    console.error('Upload error:', { fileId, errorMsg });
                },
                onSuccess: (results) => {
                    console.log('Upload success:', results);
                }
            });
        } catch (error) {
            console.error('Upload failed:', error);
        } finally {
            setIsUploading(false);
        }
    }, [uploadService]);

    const cancelUpload = useCallback((fileId: string) => {
        uploadService.cancelUpload(fileId);
    }, [uploadService]);

    const clearProgress = useCallback(() => {
        uploadService.clearAllProgress();
        setUploadProgress(new Map());
    }, [uploadService]);

    return {
        uploadFiles,
        uploadProgress,
        isUploading,
        cancelUpload,
        clearProgress
    };
}
