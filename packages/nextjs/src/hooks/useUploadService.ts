import { useMemo } from "react";
import type { UploadServiceConfig } from "../types";
import { UploadService } from "../upload-service/UploadService";

export function useUploadService(config: UploadServiceConfig): UploadService {
	return useMemo(() => {
		return new UploadService(config.baseURL, config.apiKey);
	}, [config.baseURL, config.apiKey]);
}
