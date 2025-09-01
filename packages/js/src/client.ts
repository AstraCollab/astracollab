import axios, { AxiosInstance, AxiosResponse } from 'axios';
import {
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
	MultipartUploadCompleteOptions,
	AstraCollabError
} from './types';

export class AstraCollabClient {
	private client: AxiosInstance;
	private config: AstraCollabConfig;

	constructor(config: AstraCollabConfig) {
		this.config = {
			baseURL: 'https://api.astracollab.app/v1',
			timeout: 30000,
			...config
		};

		this.client = axios.create({
			baseURL: this.config.baseURL,
			timeout: this.config.timeout,
			headers: {
				'Authorization': `Bearer ${this.config.apiKey}`,
				'Content-Type': 'application/json'
			}
		});

		// Add response interceptor for error handling
		this.client.interceptors.response.use(
			(response) => response,
			(error) => {
				if (error.response) {
					const { status, data } = error.response;
					throw new AstraCollabError(
						data?.error?.message || error.message,
						status,
						data?.error?.code,
						data?.error?.details
					);
				}
				throw new AstraCollabError(error.message);
			}
		);
	}

	// File Management

	async listFiles(folderId?: string): Promise<FileRecord[]> {
		const params = new URLSearchParams();
		if (folderId) params.append('folderId', folderId);

		const response: AxiosResponse<ApiResponse<FileRecord[]>> = await this.client.get(
			`/files?${params.toString()}`
		);

		return response.data.data || [];
	}

	async uploadFile(options: UploadFileOptions): Promise<string> {
		const formData = new FormData();
		formData.append('file', options.file);
		
		if (options.fileName) {
			formData.append('fileName', options.fileName);
		}
		if (options.folderId) {
			formData.append('folderId', options.folderId);
		}
		if (options.orgId) {
			formData.append('orgId', options.orgId);
		}

		const response: AxiosResponse<ApiResponse<{ fileId: string }>> = await this.client.post(
			'/files/upload',
			formData,
			{
				headers: {
					'Content-Type': 'multipart/form-data'
				},
				onUploadProgress: options.onProgress ? (progressEvent) => {
					if (progressEvent.total) {
						const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
						options.onProgress!(progress);
					}
				} : undefined
			}
		);

		return response.data.data!.fileId;
	}

	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const response = await this.client.get(`/files/${fileId}/download`, {
			responseType: 'arraybuffer'
		});

		return response.data;
	}

	async getFile(fileId: string): Promise<FileRecord> {
		const response: AxiosResponse<ApiResponse<FileRecord>> = await this.client.get(`/files/${fileId}`);
		return response.data.data!;
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.client.delete(`/files/${fileId}`);
	}

	// Multipart Upload for Large Files

	async startMultipartUpload(options: MultipartUploadStartOptions): Promise<MultipartUploadStartResponse> {
		const response: AxiosResponse<ApiResponse<MultipartUploadStartResponse>> = await this.client.post(
			'/files/multipart-upload-start',
			options
		);

		return response.data.data!;
	}

	async completeMultipartUpload(options: MultipartUploadCompleteOptions): Promise<void> {
		await this.client.post('/files/multipart-upload-complete', options);
	}

	// Folder Management

	async listFolders(parentFolderId?: string): Promise<Folder[]> {
		const params = new URLSearchParams();
		if (parentFolderId) params.append('parentFolderId', parentFolderId);

		const response: AxiosResponse<ApiResponse<Folder[]>> = await this.client.get(
			`/folders?${params.toString()}`
		);

		return response.data.data || [];
	}

	async createFolder(options: CreateFolderOptions): Promise<Folder> {
		const response: AxiosResponse<ApiResponse<Folder>> = await this.client.post('/folders', options);
		return response.data.data!;
	}

	async deleteFolder(folderId: string): Promise<void> {
		await this.client.delete(`/folders/${folderId}`);
	}

	// API Key Management

	async listApiKeys(): Promise<ApiKey[]> {
		const response: AxiosResponse<ApiResponse<ApiKey[]>> = await this.client.get('/keys');
		return response.data.data || [];
	}

	async createApiKey(options: CreateApiKeyOptions): Promise<ApiKey> {
		const response: AxiosResponse<ApiResponse<ApiKey>> = await this.client.post('/keys', options);
		return response.data.data!;
	}

	async revokeApiKey(keyId: string): Promise<void> {
		await this.client.delete(`/keys/${keyId}`);
	}

	// Billing

	async getBillingInfo(): Promise<BillingInfo> {
		const response: AxiosResponse<ApiResponse<BillingInfo>> = await this.client.get('/billing');
		return response.data.data!;
	}

	async getUsageHistory(): Promise<BillingInfo['usageHistory']> {
		const response: AxiosResponse<ApiResponse<BillingInfo['usageHistory']>> = await this.client.get('/billing/usage');
		return response.data.data || [];
	}

	// Utility Methods

	getConfig(): AstraCollabConfig {
		return { ...this.config };
	}

	updateConfig(newConfig: Partial<AstraCollabConfig>): void {
		this.config = { ...this.config, ...newConfig };
		
		// Update axios instance
		this.client.defaults.baseURL = this.config.baseURL;
		this.client.defaults.timeout = this.config.timeout;
		this.client.defaults.headers['Authorization'] = `Bearer ${this.config.apiKey}`;
	}
}
