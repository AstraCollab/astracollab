# @astracollab/nextjs

AstraCollab Next.js SDK with React hooks and components for file uploads.

## Features

- 🚀 **Decoupled Architecture**: Use the upload service without UI, or with our pre-built components
- 📁 **File Upload Management**: Handle single and multiple file uploads with progress tracking
- 🔄 **Real-time Progress**: Track upload progress with Web Workers for smooth UI updates
- 🎨 **Flexible UI**: Use our pre-built components or create your own UI
- 🔧 **TypeScript Support**: Full TypeScript support with comprehensive type definitions
- ⚡ **Next.js Optimized**: Built specifically for Next.js applications
- 📦 **Zero Configuration**: Includes all necessary dependencies (React Query, Axios, etc.)

## Installation

```bash
npm install @astracollab/nextjs
# or
yarn add @astracollab/nextjs
# or
pnpm add @astracollab/nextjs
```

**Note**: This package automatically installs `@tanstack/react-query` and `axios` as dependencies, so you don't need to install them separately.

## Quick Start

### 1. Basic Usage with Pre-built UI

```tsx
import { FileUploaderWithUI } from '@astracollab/nextjs';

function MyComponent() {
  const config = {
    baseURL: 'https://api.astracollab.app',
    apiKey: 'your-api-key'
  };

  return (
    <FileUploaderWithUI
      config={config}
      folderId="optional-folder-id"
      orgId="optional-org-id"
      maxFiles={5}
      onUploadComplete={(results) => {
        console.log('Upload completed:', results);
      }}
      onUploadError={(error, fileId) => {
        console.error('Upload failed:', error);
      }}
    />
  );
}
```

### 2. Custom UI with Upload Service

```tsx
import { useUploadService, useUpload } from '@astracollab/nextjs';

function CustomUploader() {
  const config = {
    baseURL: 'https://api.astracollab.app',
    apiKey: 'your-api-key'
  };

  const uploadService = useUploadService(config);
  const { uploadFiles, uploadProgress, isUploading } = useUpload(uploadService);

  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files);
    uploadFiles(files);
  };

  return (
    <div>
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
```

### 3. Using the Upload Service Directly

```tsx
import { UploadService } from '@astracollab/nextjs';

const uploadService = new UploadService('https://api.astracollab.app', 'your-api-key');

// Upload a single file
const fileId = await uploadService.uploadSingleFile({
  file: fileObject,
  fileName: 'example.jpg',
  folderId: 'optional-folder-id',
  orgId: 'optional-org-id'
});

// Upload multiple files
await uploadService.uploadMultipleFiles({
  files: [
    { id: '1', file: file1, name: 'file1.jpg', size: 1024 },
    { id: '2', file: file2, name: 'file2.jpg', size: 2048 }
  ],
  folderId: 'optional-folder-id',
  orgId: 'optional-org-id',
  onProgress: (progressMap) => {
    console.log('Upload progress:', progressMap);
  },
  onError: (errorMsg, fileId) => {
    console.error('Upload error:', errorMsg);
  },
  onSuccess: (results) => {
    console.log('Upload success:', results);
  }
});
```

## API Reference

### Components

#### FileUploaderWithUI

A complete file upload component with drag-and-drop interface and progress tracking.

```tsx
<FileUploaderWithUI
  config={UploadServiceConfig}
  folderId?: string
  orgId?: string
  maxFiles?: number
  onUploadComplete?: (results: { fileId: string; fileName: string; }[]) => void
  onUploadError?: (error: string, fileId: string) => void
  onUploadProgress?: (progressMap: Map<string, FileUploadProgress>) => void
  className?: string
  dropzoneClassName?: string
  listClassName?: string
  itemClassName?: string
  buttonClassName?: string
  progressBarClassName?: string
  statusClassName?: string
/>
```

#### FileUploader

A minimal file upload component without UI styling.

```tsx
<FileUploader
  config={UploadServiceConfig}
  folderId?: string
  orgId?: string
  maxFiles?: number
  onUploadComplete?: (results: { fileId: string; fileName: string; }[]) => void
  onUploadError?: (error: string, fileId: string) => void
  onUploadProgress?: (progressMap: Map<string, FileUploadProgress>) => void
  className?: string
  children?: React.ReactNode
/>
```

### Hooks

#### useUploadService

Creates and manages an upload service instance.

```tsx
const uploadService = useUploadService({
  baseURL: string
  apiKey?: string
  timeout?: number
});
```

#### useUpload

Provides upload functionality with progress tracking.

```tsx
const {
  uploadFiles,
  uploadProgress,
  isUploading,
  cancelUpload,
  clearProgress
} = useUpload(uploadService);
```

#### useFiles

Fetches files from the API.

```tsx
const {
  files,
  isLoading,
  error,
  refetch
} = useFiles(baseURL, apiKey, folderId, orgId);
```

### UploadService

The core upload service class.

```tsx
const uploadService = new UploadService(baseURL, apiKey);

// Methods
uploadService.uploadSingleFile(options: SingleFileUploadOptions): Promise<string>
uploadService.uploadMultipleFiles(config: UploadBatchConfig): Promise<void>
uploadService.cancelUpload(fileId: string): void
uploadService.getProgress(fileId: string): FileUploadProgress | undefined
uploadService.getAllProgress(): Map<string, FileUploadProgress>
uploadService.clearProgress(fileId: string): void
uploadService.clearAllProgress(): void
uploadService.addProgressListener(listener: (progressMap: Map<string, FileUploadProgress>) => void): void
uploadService.removeProgressListener(listener: (progressMap: Map<string, FileUploadProgress>) => void): void
```

## Types

### FileUploadProgress

```tsx
interface FileUploadProgress {
  fileId: string;
  fileName: string;
  totalBytes: number;
  uploadedBytes: number;
  progressPercentage: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed' | 'canceled';
  error?: string;
}
```

### UploadServiceConfig

```tsx
interface UploadServiceConfig {
  baseURL: string;
  apiKey?: string;
  timeout?: number;
}
```

### SingleFileUploadOptions

```tsx
interface SingleFileUploadOptions {
  file: File;
  fileName?: string;
  folderId?: string;
  orgId?: string;
  onProgress?: (progress: number) => void;
}
```

## Examples

### Custom Styling

```tsx
<FileUploaderWithUI
  config={config}
  className="my-uploader"
  dropzoneClassName="custom-dropzone"
  buttonClassName="custom-button"
  progressBarClassName="custom-progress"
/>
```

### Custom File Input

```tsx
<FileUploader config={config}>
  <button className="my-custom-button">
    Choose Files
  </button>
</FileUploader>
```

### Progress Tracking

```tsx
function UploadWithProgress() {
  const [progress, setProgress] = useState(new Map());
  
  return (
    <FileUploaderWithUI
      config={config}
      onUploadProgress={setProgress}
    />
  );
}
```

## Dependencies

This package includes the following dependencies:

- `@tanstack/react-query` - For data fetching and caching
- `axios` - For HTTP requests
- `uuid` - For generating unique identifiers

You don't need to install these separately - they're automatically included when you install `@astracollab/nextjs`.

## License

MIT
