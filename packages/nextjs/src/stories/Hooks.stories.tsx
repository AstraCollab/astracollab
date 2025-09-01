import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { useUploadService } from "../hooks/useUploadService";
import { useUpload } from "../hooks/useUpload";
import { useFiles } from "../hooks/useFiles";

// Hook demonstration components
const UploadServiceDemo: React.FC<{ config: any }> = ({ config }) => {
  const uploadService = useUploadService(config);
  const { uploadFiles, uploadProgress, isUploading, cancelUpload } = useUpload(uploadService);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      uploadFiles(files);
    }
  };

  return (
    <div style={{ padding: "20px", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
      <h3>Upload Service Hook Demo</h3>
      <input
        type="file"
        multiple
        onChange={handleFileSelect}
        style={{ marginBottom: "16px" }}
      />
      
      <div style={{ marginBottom: "16px" }}>
        <strong>Status:</strong> {isUploading ? "Uploading..." : "Ready"}
      </div>

      {uploadProgress.size > 0 && (
        <div>
          <strong>Progress:</strong>
          {Array.from(uploadProgress.values()).map((progress) => (
            <div key={progress.fileId} style={{ marginTop: "8px" }}>
              <div>{progress.fileName}</div>
              <div style={{ 
                width: "100%", 
                height: "8px", 
                backgroundColor: "#e5e7eb", 
                borderRadius: "4px",
                overflow: "hidden"
              }}>
                <div style={{
                  width: `${progress.progressPercentage}%`,
                  height: "100%",
                  backgroundColor: "#3b82f6",
                  transition: "width 0.3s ease"
                }} />
              </div>
              <div style={{ fontSize: "12px", color: "#6b7280" }}>
                {progress.progressPercentage}% ({progress.uploadedBytes} / {progress.totalBytes} bytes)
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const FilesListDemo: React.FC<{ config: any }> = ({ config }) => {
  const { files, isLoading, error, refetch } = useFiles(
    config.baseURL,
    config.apiKey
  );

  return (
    <div style={{ padding: "20px", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
      <h3>Files List Hook Demo</h3>
      
      <button 
        onClick={refetch}
        style={{
          padding: "8px 16px",
          backgroundColor: "#3b82f6",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
          marginBottom: "16px"
        }}
      >
        Refresh Files
      </button>

      {isLoading && <div>Loading files...</div>}
      
      {error && (
        <div style={{ color: "#ef4444", marginBottom: "16px" }}>
          Error: {error.message}
        </div>
      )}

      {files.length > 0 ? (
        <div>
          <strong>Files ({files.length}):</strong>
          <ul style={{ marginTop: "8px" }}>
            {files.map((file: any) => (
              <li key={file.id} style={{ marginBottom: "4px" }}>
                {file.name} - {file.size} bytes
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div style={{ color: "#6b7280" }}>No files found</div>
      )}
    </div>
  );
};

const meta: Meta = {
  title: "Hooks",
  parameters: {
    layout: "padded",
  },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const UploadService: Story = {
  render: () => (
    <UploadServiceDemo 
      config={{
        baseURL: "https://api.astracollab.app/v1",
        apiKey: "demo-api-key"
      }}
    />
  ),
};

export const FilesList: Story = {
  render: () => (
    <FilesListDemo 
      config={{
        baseURL: "https://api.astracollab.app/v1",
        apiKey: "demo-api-key"
      }}
    />
  ),
};

export const CombinedHooks: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "20px" }}>
      <UploadServiceDemo 
        config={{
          baseURL: "https://api.astracollab.app/v1",
          apiKey: "demo-api-key"
        }}
      />
      <FilesListDemo 
        config={{
          baseURL: "https://api.astracollab.app/v1",
          apiKey: "demo-api-key"
        }}
      />
    </div>
  ),
};

