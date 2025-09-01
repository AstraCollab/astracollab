import type { Meta, StoryObj } from "@storybook/react";
import { FileUploader } from "../components/FileUploader";
import type { FileUploadProgress } from "../types";

const meta: Meta<typeof FileUploader> = {
  title: "Components/FileUploader",
  component: FileUploader,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component: "A minimal file uploader component that provides the core upload functionality without UI. Perfect for integrating into custom designs or existing components. You provide the trigger element and handle the upload logic.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    maxFiles: {
      control: { type: "number", min: 1, max: 10 },
      description: "Maximum number of files that can be uploaded at once",
    },
    folderId: {
      control: "text",
      description: "Optional folder ID to upload files to",
    },
    orgId: {
      control: "text",
      description: "Optional organization ID",
    },
    onUploadComplete: {
      action: "uploadComplete",
      description: "Callback when upload completes",
    },
    onUploadError: {
      action: "uploadError",
      description: "Callback when upload fails",
    },
    onUploadProgress: {
      action: "uploadProgress",
      description: "Callback for upload progress updates",
    },
    className: {
      control: "text",
      description: "Custom CSS class for the container",
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 5,
  },
  parameters: {
    docs: {
      description: {
        story: "Default file uploader with a simple button trigger. Uses the component's default styling.",
      },
    },
  },
};

export const WithCustomButton: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 3,
    children: (
      <button
        style={{
          padding: "16px 32px",
          backgroundColor: "#10b981",
          color: "white",
          border: "none",
          borderRadius: "8px",
          cursor: "pointer",
          fontSize: "18px",
          fontWeight: "bold",
          boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
          transition: "all 0.2s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "translateY(-2px)";
          e.currentTarget.style.boxShadow = "0 6px 12px rgba(0, 0, 0, 0.15)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "translateY(0)";
          e.currentTarget.style.boxShadow = "0 4px 6px rgba(0, 0, 0, 0.1)";
        }}
      >
        📁 Select Files to Upload
      </button>
    ),
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader with a custom styled button trigger. Demonstrates how to provide your own UI elements.",
      },
    },
  },
};

export const WithProgress: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 5,
    onUploadProgress: (progress: Map<string, FileUploadProgress>) => {
      console.log("Upload progress:", progress);
    },
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader with progress tracking. The onUploadProgress callback receives real-time updates.",
      },
    },
  },
};

export const WithCallbacks: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 5,
    onUploadComplete: (results: { fileId: string; fileName: string; }[]) => {
      console.log("Upload completed:", results);
      alert(`Successfully uploaded ${results.length} files!`);
    },
    onUploadError: (error: string, fileId: string) => {
      console.error("Upload error:", error, fileId);
      alert(`Upload failed: ${error}`);
    },
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader with complete callback handling for success and error states.",
      },
    },
  },
};

export const SingleFile: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 1,
    children: (
      <button
        style={{
          padding: "12px 24px",
          backgroundColor: "#3b82f6",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          fontSize: "16px",
          fontWeight: "500",
        }}
      >
        Upload Single File
      </button>
    ),
  },
  parameters: {
    docs: {
      description: {
        story: "Single file uploader - users can only select and upload one file at a time.",
      },
    },
  },
};

export const IntegratedInForm: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 5,
    children: (
      <div style={{ 
        display: "flex", 
        alignItems: "center", 
        gap: "12px",
        padding: "16px",
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        backgroundColor: "#f9fafb"
      }}>
        <span style={{ fontSize: "14px", color: "#374151" }}>
          Attach files:
        </span>
        <button
          style={{
            padding: "8px 16px",
            backgroundColor: "#6b7280",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "14px",
          }}
        >
          Browse Files
        </button>
      </div>
    ),
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader integrated into a form-like interface, showing how it can be embedded in existing UI.",
      },
    },
  },
};
