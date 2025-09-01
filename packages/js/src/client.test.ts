import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AstraCollabClient } from './client';
import { AstraCollabError } from './types';

// Mock axios
vi.mock('axios', () => ({
	default: {
		create: vi.fn(() => ({
			get: vi.fn(),
			post: vi.fn(),
			delete: vi.fn(),
			interceptors: {
				response: {
					use: vi.fn()
				}
			}
		}))
	}
}));

describe('AstraCollabClient', () => {
	let client: AstraCollabClient;
	const mockAxios = vi.mocked(require('axios').default);

	beforeEach(() => {
		client = new AstraCollabClient({
			apiKey: 'test-api-key'
		});
	});

	describe('constructor', () => {
		it('should create client with default config', () => {
			expect(mockAxios.create).toHaveBeenCalledWith({
				baseURL: 'https://api.astracollab.app/v1',
				timeout: 30000,
				headers: {
					'Authorization': 'Bearer test-api-key',
					'Content-Type': 'application/json'
				}
			});
		});

		it('should create client with custom config', () => {
			const customClient = new AstraCollabClient({
				apiKey: 'custom-key',
				baseURL: 'https://custom-api.com/v1',
				timeout: 60000
			});

			expect(mockAxios.create).toHaveBeenCalledWith({
				baseURL: 'https://custom-api.com/v1',
				timeout: 60000,
				headers: {
					'Authorization': 'Bearer custom-key',
					'Content-Type': 'application/json'
				}
			});
		});
	});

	describe('listFiles', () => {
		it('should list files without folderId', async () => {
			const mockResponse = {
				data: {
					success: true,
					data: [
						{ id: '1', name: 'file1.jpg', size: '1024', type: 'image/jpeg', uploadedAt: '2024-01-01' }
					]
				}
			};

			const mockAxiosInstance = mockAxios.create();
			mockAxiosInstance.get.mockResolvedValue(mockResponse);

			const files = await client.listFiles();
			expect(files).toEqual(mockResponse.data.data);
			expect(mockAxiosInstance.get).toHaveBeenCalledWith('/files?');
		});

		it('should list files with folderId', async () => {
			const mockResponse = {
				data: {
					success: true,
					data: []
				}
			};

			const mockAxiosInstance = mockAxios.create();
			mockAxiosInstance.get.mockResolvedValue(mockResponse);

			await client.listFiles('folder-123');
			expect(mockAxiosInstance.get).toHaveBeenCalledWith('/files?folderId=folder-123');
		});
	});

	describe('uploadFile', () => {
		it('should upload file successfully', async () => {
			const mockResponse = {
				data: {
					success: true,
					data: { fileId: 'file-123' }
				}
			};

			const mockAxiosInstance = mockAxios.create();
			mockAxiosInstance.post.mockResolvedValue(mockResponse);

			const file = new Blob(['test content'], { type: 'text/plain' });
			const fileId = await client.uploadFile({
				file,
				fileName: 'test.txt',
				folderId: 'folder-123'
			});

			expect(fileId).toBe('file-123');
			expect(mockAxiosInstance.post).toHaveBeenCalledWith(
				'/files/upload',
				expect.any(FormData),
				expect.objectContaining({
					headers: {
						'Content-Type': 'multipart/form-data'
					}
				})
			);
		});
	});

	describe('error handling', () => {
		it('should throw AstraCollabError on API error', async () => {
			const mockAxiosInstance = mockAxios.create();
			mockAxiosInstance.get.mockRejectedValue({
				response: {
					status: 401,
					data: {
						error: {
							code: 'UNAUTHORIZED',
							message: 'Invalid API key'
						}
					}
				}
			});

			await expect(client.listFiles()).rejects.toThrow(AstraCollabError);
		});
	});

	describe('configuration', () => {
		it('should get current config', () => {
			const config = client.getConfig();
			expect(config).toEqual({
				apiKey: 'test-api-key',
				baseURL: 'https://api.astracollab.app/v1',
				timeout: 30000
			});
		});

		it('should update config', () => {
			client.updateConfig({
				apiKey: 'new-key',
				timeout: 60000
			});

			const config = client.getConfig();
			expect(config.apiKey).toBe('new-key');
			expect(config.timeout).toBe(60000);
		});
	});
});
