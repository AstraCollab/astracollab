// Main exports
export { AstraCollabClient } from './client';

// Type exports
export type {
	AstraCollabConfig,
	FileRecord,
	Folder,
	ApiKey,
	UploadFileOptions,
	CreateFolderOptions,
	CreateApiKeyOptions,
	BillingInfo,
	ApiResponse,
	MultipartUploadStartOptions,
	MultipartUploadStartResponse,
	MultipartUploadCompleteOptions
} from './types';

// Error class
export { AstraCollabError } from './types';

// Default export
import { AstraCollabClient } from './client';
export default AstraCollabClient;
