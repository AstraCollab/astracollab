import React, { useRef, useCallback } from 'react';
import type { FileUploaderProps } from '../types';
import { useUploadService } from '../hooks/useUploadService';
import { useUpload } from '../hooks/useUpload';

export const FileUploader: React.FC<FileUploaderProps> = ({
    config,
    folderId,
    orgId,
    maxFiles = 5,
    onUploadComplete,
    onUploadError,
    onUploadProgress,
    className,
    children
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadService = useUploadService(config);
    const { uploadFiles, uploadProgress, isUploading, cancelUpload } = useUpload(uploadService);

    const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        
        if (files.length > maxFiles) {
            alert(`You can only upload up to ${maxFiles} files at once.`);
            return;
        }

        uploadFiles(files);
    }, [uploadFiles, maxFiles]);

    const handleClick = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    // Notify parent of progress updates
    React.useEffect(() => {
        if (onUploadProgress) {
            onUploadProgress(uploadProgress);
        }
    }, [uploadProgress, onUploadProgress]);

    return (
        <div className={className}>
            <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                accept="*/*"
            />
            
            {children ? (
                React.cloneElement(children as React.ReactElement, {
                    onClick: handleClick,
                    disabled: isUploading
                })
            ) : (
                <button
                    type="button"
                    onClick={handleClick}
                    disabled={isUploading}
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
                >
                    {isUploading ? 'Uploading...' : 'Select Files'}
                </button>
            )}
        </div>
    );
};

export default FileUploader;
