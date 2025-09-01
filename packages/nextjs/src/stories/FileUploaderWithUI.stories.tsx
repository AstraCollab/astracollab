import type { Meta, StoryObj } from "@storybook/react";
import { FileUploaderWithUI } from "../components/FileUploaderWithUI";

const meta: Meta<typeof FileUploaderWithUI> = {
  title: "Components/FileUploaderWithUI",
  component: FileUploaderWithUI,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component: "A sophisticated file uploader component with drag-and-drop, progress tracking, and modern UI design. This component provides a complete file upload experience with real-time progress updates, error handling, and customizable styling.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
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
      description: "Custom CSS class for the main container",
    },
    dropzoneClassName: {
      control: "text",
      description: "Custom CSS class for the dropzone area",
    },
    listClassName: {
      control: "text",
      description: "Custom CSS class for the file list container",
    },
    itemClassName: {
      control: "text",
      description: "Custom CSS class for individual file items",
    },
    buttonClassName: {
      control: "text",
      description: "Custom CSS class for the upload button",
    },
    progressBarClassName: {
      control: "text",
      description: "Custom CSS class for progress bars",
    },
    statusClassName: {
      control: "text",
      description: "Custom CSS class for status messages",
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
        story: "Default file uploader with drag-and-drop functionality, progress tracking, and modern UI design.",
      },
    },
  },
};

export const WithFolder: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    folderId: "demo-folder-id",
    maxFiles: 3,
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader configured to upload files to a specific folder.",
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
  },
  parameters: {
    docs: {
      description: {
        story: "Single file uploader - users can only select and upload one file at a time.",
      },
    },
  },
};

export const CustomStyling: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 5,
    className: "border-2 border-blue-500 rounded-lg p-6 bg-blue-50",
    dropzoneClassName: "border-2 border-dashed border-blue-300 bg-blue-100 hover:bg-blue-200 transition-colors duration-200",
    listClassName: "space-y-3 mt-4",
    itemClassName: "border border-gray-200 rounded-lg p-4 bg-white shadow-sm hover:shadow-md transition-shadow duration-200",
    buttonClassName: "bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200",
    progressBarClassName: "bg-green-500 h-3 rounded-full transition-all duration-300 ease-in-out",
    statusClassName: "text-sm font-medium",
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader with custom styling to match your brand colors and design system.",
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
    onUploadComplete: (fileIds: string[]) => {
      console.log("Upload completed:", fileIds);
    },
    onUploadError: (error: Error) => {
      console.error("Upload error:", error);
    },
    onUploadProgress: (progress: number) => {
      console.log("Upload progress:", progress);
    },
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader with custom callback functions for handling upload events.",
      },
    },
  },
};

export const LargeFileSupport: Story = {
  args: {
    config: {
      baseURL: "https://api.astracollab.app/v1",
      apiKey: "demo-api-key",
    },
    maxFiles: 10,
  },
  parameters: {
    docs: {
      description: {
        story: "File uploader configured for handling multiple large files with automatic multipart upload support.",
      },
    },
  },
};
