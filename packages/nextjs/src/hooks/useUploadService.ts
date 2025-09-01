import { useMemo } from 'react';
import { UploadService } from '../upload-service/UploadService';
import type { UploadServiceConfig } from '../types';

export function useUploadService(config: UploadServiceConfig): UploadService {
    return useMemo(() => {
        return new UploadService(config.baseURL, config.apiKey);
    }, [config.baseURL, config.apiKey]);
}
