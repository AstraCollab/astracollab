import React, { useState, useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { FileUploadProgress, FileToUpload, FileUploaderProps } from '../types';
import { useUploadService } from '../hooks/useUploadService';
import { useUpload } from '../hooks/useUpload';
import { 
  Button, 
  FileUpload, 
  FileUploadDropzone, 
  FileUploadItem, 
  FileUploadItemMetadata, 
  FileUploadItemPreview, 
  FileUploadList, 
  FileUploadTrigger, 
  FileUploadItemDelete 
} from './mock-ui';

// Utility function to format file size
const formatFileSize = (sizeInBytes: number): string => {
	if (!sizeInBytes) return "0 B";
	
	const bytes = sizeInBytes;
	
	if (bytes === 0) return "0 B";
	
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	
	const size = bytes / Math.pow(k, i);
	
	// Format to 1 decimal place for MB and GB, no decimals for B and KB
	if (i >= 2) {
		return `${size.toFixed(1)} ${sizes[i]}`;
	}
	
	return `${Math.round(size)} ${sizes[i]}`;
};

interface FileUploaderWithUIProps extends Omit<FileUploaderProps, 'children'> {
    className?: string;
    dropzoneClassName?: string;
    listClassName?: string;
    itemClassName?: string;
    buttonClassName?: string;
    progressBarClassName?: string;
    statusClassName?: string;
}

export const FileUploaderWithUI: React.FC<FileUploaderWithUIProps> = ({
    config,
    folderId,
    orgId,
    maxFiles = 5,
    onUploadComplete,
    onUploadError,
    onUploadProgress,
    className = '',
    dropzoneClassName = '',
    listClassName = '',
    itemClassName = '',
    buttonClassName = '',
    progressBarClassName = '',
    statusClassName = ''
}) => {
    const [filesToUpload, setFilesToUpload] = useState<FileToUpload[]>([]);
    const [uploadProgressMap, setUploadProgressMap] = useState<Map<string, FileUploadProgress>>(new Map());
    const [isUploading, setIsUploading] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);

    const uploadService = useUploadService(config);
    const { uploadFiles, uploadProgress, isUploading: serviceUploading, cancelUpload } = useUpload(uploadService);

    // Sync progress from service
    useEffect(() => {
        setUploadProgressMap(uploadProgress);
        setIsUploading(serviceUploading);
    }, [uploadProgress, serviceUploading]);

    // Notify parent of progress updates
    useEffect(() => {
        if (onUploadProgress) {
            onUploadProgress(uploadProgressMap);
        }
    }, [uploadProgressMap, onUploadProgress]);

    const handleFileValueChange = useCallback((newFiles: File[]) => {
        const newFilesWithId: FileToUpload[] = newFiles.map((file) => ({
            id: uuidv4(),
            file,
            name: file.name,
            size: file.size,
        }));
        setFilesToUpload(newFilesWithId);

        // Initialize progress map for newly selected files
        setUploadProgressMap((prevMap) => {
            const newMap = new Map(prevMap);
            newFilesWithId.forEach((f) => {
                if (
                    !newMap.has(f.id) ||
                    newMap.get(f.id)?.status === "completed" ||
                    newMap.get(f.id)?.status === "failed"
                ) {
                    newMap.set(f.id, {
                        fileId: f.id,
                        fileName: f.name,
                        totalBytes: f.size,
                        uploadedBytes: 0,
                        status: "pending",
                        progressPercentage: 0,
                    });
                }
            });
            
            // Clean up progress for files that were removed
            const currentFileIds = new Set(newFilesWithId.map((f) => f.id));
            for (const id of prevMap.keys()) {
                if (!currentFileIds.has(id)) {
                    newMap.delete(id);
                }
            }
            return newMap;
        });
    }, []);

    const handleUpload = useCallback(async () => {
        if (filesToUpload.length === 0) {
            alert("No files selected for upload.");
            return;
        }

        setIsUploading(true);

        try {
            await uploadFiles({
                files: filesToUpload,
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
                    
                    // Clear completed files
                    setFilesToUpload(prev => 
                        prev.filter(f => !results.some(r => r.fileName === f.name))
                    );
                    
                    // Clear progress for completed files
                    setUploadProgressMap(prev => {
                        const newMap = new Map(prev);
                        results.forEach(res => {
                            for (const [key, value] of newMap.entries()) {
                                if (value.fileName === res.fileName && value.status === "completed") {
                                    newMap.delete(key);
                                    break;
                                }
                            }
                        });
                        return newMap;
                    });
                }
            });
        } catch (error) {
            console.error("Upload failed:", error);
            if (onUploadError) {
                onUploadError(error instanceof Error ? error : new Error("Upload failed"), "");
            }
        } finally {
            setIsUploading(false);
        }
    }, [filesToUpload, folderId, orgId, uploadFiles, onUploadComplete, onUploadError]);

    const removeFile = useCallback((id: string) => {
        setFilesToUpload(prev => prev.filter(f => f.id !== id));
        setUploadProgressMap(prev => {
            const newMap = new Map(prev);
            const progress = newMap.get(id);
            if (progress && progress.status !== "completed" && progress.status !== "failed") {
                newMap.delete(id);
            }
            return newMap;
        });
        cancelUpload(id);
    }, [cancelUpload]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        
        const droppedFiles = Array.from(e.dataTransfer.files);
        if (droppedFiles.length > 0) {
            handleFileValueChange(droppedFiles);
        }
    }, [handleFileValueChange]);

    const hasFilesToUpload = filesToUpload.length > 0;

    return (
        <div className={`file-upload ${className}`}>
            <FileUpload
                value={filesToUpload.map(f => f.file)}
                onValueChange={handleFileValueChange}
                maxFiles={maxFiles}
            >
                <FileUploadDropzone 
                    className={`${dropzoneClassName} ${isDragOver ? 'border-primary bg-muted/50' : ''}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >
                    <div className="flex flex-col items-center justify-center text-center">
                        <div className="mb-2 size-12 text-muted-foreground">
                            <svg className="size-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                            </svg>
                        </div>
                        <p className="text-sm text-muted-foreground mb-2">
                            Drag and drop files here, or click to browse
                        </p>
                        <FileUploadTrigger asChild>
                            <Button className={buttonClassName || "upload-button"}>
                                Select Files
                            </Button>
                        </FileUploadTrigger>
                    </div>
                </FileUploadDropzone>

                {hasFilesToUpload && (
                    <FileUploadList className={listClassName}>
                        {filesToUpload.map((fileWithId) => {
                            const progressState = uploadProgressMap.get(fileWithId.id) || {
                                fileId: fileWithId.id,
                                fileName: fileWithId.name,
                                totalBytes: fileWithId.size,
                                uploadedBytes: 0,
                                status: "pending" as const,
                                progressPercentage: 0,
                            };

                            let statusMessage: string;
                            switch (progressState.status) {
                                case "pending":
                                    statusMessage = "Waiting to upload";
                                    break;
                                case "uploading":
                                    statusMessage = `Uploading: ${progressState.progressPercentage}%`;
                                    break;
                                case "completed":
                                    statusMessage = "Upload complete!";
                                    break;
                                case "canceled":
                                    statusMessage = "Upload canceled";
                                    break;
                                case "failed":
                                    statusMessage = `Error: ${progressState.error || "Unknown error"}`;
                                    break;
                                default:
                                    statusMessage = "Ready";
                            }

                            const isDeleteDisabled = isUploading && 
                                (progressState.status === "uploading" || progressState.status === "pending");

                            return (
                                <FileUploadItem
                                    key={fileWithId.id}
                                    value={fileWithId.file}
                                    className={`${itemClassName}`}
                                    data-file-id={fileWithId.id}
                                >
                                    <FileUploadItemPreview className="size-10 rounded-full bg-muted p-2 text-primary">
                                        <svg className="size-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                    </FileUploadItemPreview>

                                    <FileUploadItemMetadata className="flex-1 px-4">
                                        <p className="text-sm font-medium text-foreground">{fileWithId.name}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {formatFileSize(fileWithId.size)}
                                        </p>
                                    </FileUploadItemMetadata>

                                    <div className="flex w-40 flex-col items-end">
                                        {progressState.status !== "completed" && progressState.status !== "failed" && (
                                            <div className={`progress-bar ${progressBarClassName}`}>
                                                <div
                                                    className={`progress-bar-fill ${progressBarClassName}`}
                                                    style={{
                                                        width: `${progressState.progressPercentage}%`,
                                                    }}
                                                />
                                            </div>
                                        )}
                                        <span className={`text-xs min-w-[5rem] text-right ${statusClassName} ${
                                            progressState.status === "failed" ? "text-destructive" : "text-muted-foreground"
                                        }`}>
                                            {statusMessage}
                                        </span>
                                    </div>

                                    <FileUploadItemDelete asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className={`file-upload-item-delete ${isDeleteDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            onClick={() => removeFile(fileWithId.id)}
                                            disabled={isDeleteDisabled}
                                        >
                                            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </Button>
                                    </FileUploadItemDelete>
                                </FileUploadItem>
                            );
                        })}

                        <Button
                            className={`upload-button w-full mt-4 ${buttonClassName}`}
                            onClick={handleUpload}
                            disabled={filesToUpload.length === 0 || isUploading}
                        >
                            {isUploading
                                ? "Uploading..."
                                : `Upload ${filesToUpload.length} File(s)`}
                        </Button>
                    </FileUploadList>
                )}
            </FileUpload>
        </div>
    );
};
