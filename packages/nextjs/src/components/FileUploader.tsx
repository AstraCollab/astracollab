import React, { useRef, useCallback } from 'react';
import type { FileUploaderProps } from '../types';
import { useUploadService } from '../hooks/useUploadService';
import { useUpload } from '../hooks/useUpload';
import { Button } from './mock-ui';

export const FileUploader: React.FC<FileUploaderProps> = ({
    config,
    folderId,
    orgId,
    maxFiles = 5,
    onUploadComplete,
    onUploadError,
    onUploadProgress,
    children,
    className = '',
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadService = useUploadService(config);
    const { uploadFiles, uploadProgress, isUploading, cancelUpload } = useUpload(uploadService);

    const handleFileSelect = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;

        if (files.length > maxFiles) {
            alert(`You can only upload up to ${maxFiles} files at once.`);
            return;
        }

        const fileObjects = files.map(file => ({
            id: crypto.randomUUID(),
            file,
            name: file.name,
            size: file.size,
        }));

        uploadFiles({
            files: fileObjects,
            folderId,
            orgId,
            onError: (errorMsg, fileId) => {
                if (onUploadError) {
                    onUploadError(new Error(errorMsg), fileId);
                }
            },
            onSuccess: (results) => {
                if (onUploadComplete) {
                    onUploadComplete(results.map(r => r.fileId));
                }
            }
        });

        // Reset input
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }, [maxFiles, folderId, orgId, uploadFiles, onUploadComplete, onUploadError]);

    // Notify parent of progress updates
    React.useEffect(() => {
        if (onUploadProgress) {
            onUploadProgress(uploadProgress);
        }
    }, [uploadProgress, onUploadProgress]);

    return (
        <div className={`file-uploader ${className}`}>
            <input
                ref={fileInputRef}
                type="file"
                multiple={maxFiles > 1}
                onChange={handleFileChange}
                className="hidden"
                accept="*/*"
            />
            
            {children ? (
                React.cloneElement(children as React.ReactElement, {
                    onClick: handleFileSelect,
                })
            ) : (
                <Button onClick={handleFileSelect} className="upload-button">
                    Select Files
                </Button>
            )}
        </div>
    );
};

export default FileUploader;
