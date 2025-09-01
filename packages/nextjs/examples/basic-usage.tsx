import React from 'react';
import { FileUploaderWithUI, useUploadService, useUpload, useFiles } from '@astracollab/nextjs';

// Example 1: Basic usage with pre-built UI
export function BasicUploadExample() {
  const config = {
    baseURL: 'https://api.astracollab.app',
    apiKey: 'your-api-key'
  };

  return (
    <div>
      <h2>Basic File Upload</h2>
      <FileUploaderWithUI
        config={config}
        folderId="my-folder"
        orgId="my-org"
        maxFiles={5}
        onUploadComplete={(results) => {
          console.log('Upload completed:', results);
        }}
        onUploadError={(error, fileId) => {
          console.error('Upload failed:', error);
        }}
      />
    </div>
  );
}

// Example 2: Custom UI with hooks
export function CustomUploadExample() {
  const config = {
    baseURL: 'https://api.astracollab.app',
    apiKey: 'your-api-key'
  };

  const uploadService = useUploadService(config);
  const { uploadFiles, uploadProgress, isUploading } = useUpload(uploadService);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    uploadFiles(files);
  };

  return (
    <div>
      <h2>Custom Upload UI</h2>
      <input type="file" multiple onChange={handleFileSelect} />
      {isUploading && <p>Uploading files...</p>}
      
      {/* Display progress for each file */}
      {Array.from(uploadProgress.entries()).map(([fileId, progress]) => (
        <div key={fileId}>
          <p>{progress.fileName}: {progress.progressPercentage}%</p>
        </div>
      ))}
    </div>
  );
}

// Example 3: File listing with React Query
export function FileListExample() {
  const { files, isLoading, error } = useFiles(
    'https://api.astracollab.app',
    'your-api-key',
    'my-folder',
    'my-org'
  );

  if (isLoading) return <div>Loading files...</div>;
  if (error) return <div>Error loading files: {error.message}</div>;

  return (
    <div>
      <h2>File List</h2>
      <ul>
        {files.map((file: any) => (
          <li key={file.id}>{file.name}</li>
        ))}
      </ul>
    </div>
  );
}

// Example 4: Direct service usage
export function DirectServiceExample() {
  const handleUpload = async () => {
    const { UploadService } = await import('@astracollab/nextjs');
    const uploadService = new UploadService('https://api.astracollab.app', 'your-api-key');

    try {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.onchange = async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) {
          const fileId = await uploadService.uploadSingleFile({
            file,
            fileName: file.name,
            folderId: 'my-folder',
            orgId: 'my-org'
          });
          console.log('File uploaded with ID:', fileId);
        }
      };
      fileInput.click();
    } catch (error) {
      console.error('Upload failed:', error);
    }
  };

  return (
    <div>
      <h2>Direct Service Usage</h2>
      <button onClick={handleUpload}>Upload File</button>
    </div>
  );
}
