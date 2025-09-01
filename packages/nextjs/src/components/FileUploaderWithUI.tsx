import React, { useState, useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { FileUploadProgress, FileToUpload, FileUploaderProps } from '../types';
import { useUploadService } from '../hooks/useUploadService';
import { useUpload } from '../hooks/useUpload';

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

        // Reset status for files that might be re-attempted
        setUploadProgressMap((prevMap) => {
            const newMap = new Map(prevMap);
            filesToUpload.forEach((f) => {
                const currentProgress = newMap.get(f.id);
                if (
                    currentProgress &&
                    (currentProgress.status === "failed" ||
                        currentProgress.status === "completed" ||
                        currentProgress.status === "canceled")
                ) {
                    newMap.set(f.id, {
                        ...currentProgress,
                        uploadedBytes: 0,
                        progressPercentage: 0,
                        status: "pending",
                        error: undefined,
                    });
                } else if (!currentProgress) {
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
            return newMap;
        });

        try {
            await uploadFiles(filesToUpload.map(f => f.file));
            
            // Clear files from the list that successfully completed
            setFilesToUpload((prevFiles) =>
                prevFiles.filter(
                    (f) =>
                        !Array.from(uploadProgressMap.values()).some(
                            (p) => p.fileName === f.name && p.status === "completed"
                        )
                )
            );

            // Clear progress map for completed files
            setUploadProgressMap((prevMap) => {
                const newMap = new Map(prevMap);
                Array.from(newMap.entries()).forEach(([key, value]) => {
                    if (value.status === "completed") {
                        newMap.delete(key);
                    }
                });
                return newMap;
            });

            onUploadComplete?.(Array.from(uploadProgressMap.values())
                .filter(p => p.status === "completed")
                .map(p => ({ fileId: p.fileId, fileName: p.fileName })));
        } catch (error) {
            console.error("Overall upload process failed:", error);
            onUploadError?.("An error occurred during the batch upload process.", "");
        } finally {
            setIsUploading(false);
        }
    }, [filesToUpload, uploadProgressMap, uploadFiles, onUploadComplete, onUploadError]);

    const removeFile = useCallback((id: string) => {
        setFilesToUpload((prevFiles) => prevFiles.filter((f) => f.id !== id));
        setUploadProgressMap((prevMap) => {
            const newMap = new Map(prevMap);
            const progress = newMap.get(id);
            if (
                progress &&
                progress.status !== "completed" &&
                progress.status !== "failed"
            ) {
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
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > maxFiles) {
            alert(`You can only upload up to ${maxFiles} files at once.`);
            return;
        }
        
        handleFileValueChange(files);
    }, [handleFileValueChange, maxFiles]);

    const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length > maxFiles) {
            alert(`You can only upload up to ${maxFiles} files at once.`);
            return;
        }
        handleFileValueChange(files);
    }, [handleFileValueChange, maxFiles]);

    const hasFilesToUpload = filesToUpload.length > 0;

    return (
        <div className={className}>
            {/* Dropzone */}
            <div
                className={`flex h-52 flex-col items-center justify-center rounded-lg border-2 border-dashed bg-background p-4 text-center ${
                    isDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
                } ${dropzoneClassName}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <svg className="mb-2 h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-sm text-gray-500">
                    Drag and drop files here, or click to browse.
                </p>
                <input
                    type="file"
                    multiple
                    onChange={handleFileInput}
                    className="mt-4 hidden"
                    id="file-upload-input"
                    accept="*/*"
                />
                <label
                    htmlFor="file-upload-input"
                    className={`mt-4 cursor-pointer rounded-md bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 ${buttonClassName}`}
                >
                    Select Files
                </label>
            </div>

            {/* File List */}
            {hasFilesToUpload && (
                <div className={`mt-4 flex flex-col gap-3 ${listClassName}`}>
                    {filesToUpload.map((fileWithId) => {
                        const progressState =
                            uploadProgressMap.get(fileWithId.id) ||
                            Array.from(uploadProgressMap.values()).find(
                                (p) =>
                                    p.fileName === fileWithId.name &&
                                    p.totalBytes === fileWithId.size &&
                                    p.status !== "pending",
                            ) ||
                            ({
                                fileId: fileWithId.id,
                                fileName: fileWithId.name,
                                totalBytes: fileWithId.size,
                                uploadedBytes: 0,
                                status: "pending",
                                progressPercentage: 0,
                            } as FileUploadProgress);

                        let statusMessage: string;
                        switch (progressState.status) {
                            case "pending":
                                statusMessage = "Waiting to upload";
                                break;
                            case "uploading":
                                statusMessage = `Uploading: ${progressState.progressPercentage}% (${(
                                    progressState.uploadedBytes / (1024 * 1024)
                                ).toFixed(2)}MB / ${(
                                    progressState.totalBytes / (1024 * 1024)
                                ).toFixed(2)}MB)`;
                                break;
                            case "completed":
                                statusMessage = "Upload complete!";
                                break;
                            case "canceled":
                                statusMessage = "Upload canceled.";
                                break;
                            case "failed":
                                statusMessage = `Error: ${progressState.error || "Unknown error"}`;
                                break;
                            default:
                                statusMessage = "Ready";
                        }

                        const isDeleteDisabled =
                            isUploading &&
                            (progressState.status === "uploading" ||
                                progressState.status === "pending");

                        return (
                            <div
                                key={fileWithId.id}
                                className={`flex items-center justify-between rounded-md border p-4 ${itemClassName}`}
                            >
                                <div className="flex items-center space-x-4">
                                    <div className="h-10 w-10 rounded-full bg-gray-100 p-2">
                                        <svg className="h-6 w-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium">{fileWithId.name}</p>
                                        <p className="text-xs text-gray-500">
                                            {(fileWithId.size / (1024 * 1024)).toFixed(2)} MB
                                        </p>
                                    </div>
                                </div>

                                {/* Progress bar and status message */}
                                <div className="flex w-40 flex-col items-end">
                                    {progressState.status !== "completed" &&
                                        progressState.status !== "failed" && (
                                            <div className={`relative h-2 w-full overflow-hidden rounded-full bg-gray-200 ${progressBarClassName}`}>
                                                <div
                                                    className="h-full rounded-full bg-blue-500 transition-all duration-300 ease-in-out"
                                                    style={{
                                                        width: `${progressState.progressPercentage}%`,
                                                    }}
                                                />
                                            </div>
                                        )}
                                    <span
                                        className={`text-xs min-w-[5rem] text-right ${
                                            progressState.status === "failed" ? "text-red-500" : "text-gray-500"
                                        } ${statusClassName}`}
                                    >
                                        {statusMessage}
                                    </span>
                                </div>

                                <button
                                    type="button"
                                    className="h-7 w-7 rounded-md p-1 hover:bg-gray-100 disabled:opacity-50"
                                    onClick={() => removeFile(fileWithId.id)}
                                    disabled={isDeleteDisabled}
                                >
                                    <svg className="h-4 w-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        );
                    })}
                    
                    <button
                        className={`bg-blue-500 text-white font-bold w-full mt-4 rounded-md py-2 hover:bg-blue-600 disabled:opacity-50 ${buttonClassName}`}
                        onClick={handleUpload}
                        disabled={filesToUpload.length === 0 || isUploading}
                    >
                        {isUploading
                            ? "Uploading..."
                            : `Upload ${filesToUpload.length} File(s)`}
                    </button>
                </div>
            )}
        </div>
    );
};
