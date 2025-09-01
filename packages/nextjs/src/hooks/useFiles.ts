import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import type { UseFilesReturn } from '../types';

export function useFiles(
    baseURL: string, 
    apiKey?: string, 
    folderId?: string, 
    orgId?: string
): UseFilesReturn {
    const { data: files, isLoading, error, refetch } = useQuery({
        queryKey: ['files', folderId, orgId],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (folderId) params.append('folderId', folderId);
            if (orgId) params.append('orgId', orgId);

            const response = await axios.get(`${baseURL}/api/v1/files?${params.toString()}`, {
                headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
            });

            return response.data;
        },
        enabled: !!baseURL
    });

    return {
        files: files || [],
        isLoading,
        error: error as Error | null,
        refetch
    };
}
