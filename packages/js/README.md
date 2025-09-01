# @astracollab/js

Official AstraCollab JavaScript SDK for Node.js and browser environments. Perfect for server-side applications, CLI tools, and browser-based file management.

## Installation

```bash
npm install @astracollab/js
```

## Quick Start

### Basic Usage

```javascript
import { AstraCollabClient } from '@astracollab/js';

const client = new AstraCollabClient({
  apiKey: 'your-api-key-here'
});

// List files
const files = await client.listFiles();
console.log('Files:', files);

// Upload a file
const fileId = await client.uploadFile({
  file: fileObject,
  fileName: 'example.jpg',
  folderId: 'optional-folder-id'
});
console.log('File uploaded:', fileId);
```

### Node.js Example

```javascript
import { AstraCollabClient } from '@astracollab/js';
import fs from 'fs';

const client = new AstraCollabClient({
  apiKey: process.env.ASTRACOLLAB_API_KEY
});

// Upload a file from the filesystem
const fileBuffer = fs.readFileSync('./example.jpg');
const file = new Blob([fileBuffer], { type: 'image/jpeg' });

const fileId = await client.uploadFile({
  file,
  fileName: 'example.jpg',
  folderId: 'my-folder'
});

console.log('File uploaded with ID:', fileId);
```

## API Reference

### Constructor

```javascript
const client = new AstraCollabClient(config);
```

**Parameters:**
- `config.apiKey` (string, required): Your AstraCollab API key
- `config.baseURL` (string, optional): API base URL (defaults to `https://api.astracollab.app/v1`)
- `config.timeout` (number, optional): Request timeout in milliseconds (defaults to 30000)

### File Management

#### List Files

```javascript
const files = await client.listFiles(folderId);
```

**Parameters:**
- `folderId` (string, optional): Folder ID to list files from

**Returns:** Array of file objects

#### Upload File

```javascript
const fileId = await client.uploadFile(options);
```

**Parameters:**
- `options.file` (File|Blob, required): File to upload
- `options.fileName` (string, optional): Custom file name
- `options.folderId` (string, optional): Folder to upload to
- `options.orgId` (string, optional): Organization ID
- `options.onProgress` (function, optional): Progress callback

**Returns:** File ID string

#### Download File

```javascript
const fileBuffer = await client.downloadFile(fileId);
```

**Parameters:**
- `fileId` (string, required): ID of the file to download

**Returns:** ArrayBuffer containing file data

#### Get File Details

```javascript
const file = await client.getFile(fileId);
```

**Parameters:**
- `fileId` (string, required): ID of the file

**Returns:** File object with metadata

#### Delete File

```javascript
await client.deleteFile(fileId);
```

**Parameters:**
- `fileId` (string, required): ID of the file to delete

### Folder Management

#### List Folders

```javascript
const folders = await client.listFolders(parentFolderId);
```

**Parameters:**
- `parentFolderId` (string, optional): Parent folder ID

**Returns:** Array of folder objects

#### Create Folder

```javascript
const folder = await client.createFolder(options);
```

**Parameters:**
- `options.name` (string, required): Folder name
- `options.parentFolderId` (string, optional): Parent folder ID

**Returns:** Created folder object

#### Delete Folder

```javascript
await client.deleteFolder(folderId);
```

**Parameters:**
- `folderId` (string, required): ID of the folder to delete

### API Key Management

#### List API Keys

```javascript
const keys = await client.listApiKeys();
```

**Returns:** Array of API key objects

#### Create API Key

```javascript
const key = await client.createApiKey(options);
```

**Parameters:**
- `options.name` (string, required): API key name

**Returns:** Created API key object

#### Revoke API Key

```javascript
await client.revokeApiKey(keyId);
```

**Parameters:**
- `keyId` (string, required): API key ID to revoke

### Billing

#### Get Billing Info

```javascript
const billing = await client.getBillingInfo();
```

**Returns:** Billing information object

#### Get Usage History

```javascript
const usage = await client.getUsageHistory();
```

**Returns:** Array of usage history records

### Multipart Upload (Large Files)

#### Start Multipart Upload

```javascript
const multipartResponse = await client.startMultipartUpload(options);
```

**Parameters:**
- `options.fileName` (string, required): File name
- `options.fileType` (string, required): File MIME type
- `options.fileSize` (number, required): File size in bytes
- `options.totalChunks` (number, required): Number of chunks
- `options.folderId` (string, optional): Folder ID

**Returns:** Multipart upload response with presigned URLs

#### Complete Multipart Upload

```javascript
await client.completeMultipartUpload(options);
```

**Parameters:**
- `options.uploadId` (string, required): Upload ID
- `options.key` (string, required): File key
- `options.parts` (array, required): Array of uploaded parts with ETags
- `options.fileId` (string, required): File ID

## Examples

### Upload Multiple Files

```javascript
import { AstraCollabClient } from '@astracollab/js';

const client = new AstraCollabClient({
  apiKey: 'your-api-key-here'
});

const files = [
  { name: 'file1.jpg', data: file1Blob },
  { name: 'file2.pdf', data: file2Blob },
  { name: 'file3.txt', data: file3Blob }
];

for (const file of files) {
  try {
    const fileId = await client.uploadFile({
      file: file.data,
      fileName: file.name,
      folderId: 'my-folder'
    });
    console.log(`Uploaded ${file.name} with ID: ${fileId}`);
  } catch (error) {
    console.error(`Failed to upload ${file.name}:`, error);
  }
}
```

### Progress Tracking

```javascript
const fileId = await client.uploadFile({
  file: fileBlob,
  fileName: 'large-file.zip',
  onProgress: (progress) => {
    console.log(`Upload progress: ${progress}%`);
  }
});
```

### Error Handling

```javascript
try {
  const files = await client.listFiles();
  console.log('Files:', files);
} catch (error) {
  if (error.status === 401) {
    console.error('Authentication failed. Check your API key.');
  } else if (error.status === 429) {
    console.error('Rate limit exceeded. Try again later.');
  } else {
    console.error('An error occurred:', error.message);
  }
}
```

### CLI Tool Example

```javascript
#!/usr/bin/env node
import { AstraCollabClient } from '@astracollab/js';
import fs from 'fs';

const client = new AstraCollabClient({
  apiKey: process.env.ASTRACOLLAB_API_KEY
});

async function uploadFile(filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = filePath.split('/').pop();
    const file = new Blob([fileBuffer]);

    const fileId = await client.uploadFile({
      file,
      fileName
    });

    console.log(`✅ File uploaded successfully!`);
    console.log(`📁 File ID: ${fileId}`);
    console.log(`🔗 View at: https://app.astracollab.app/files/${fileId}`);
  } catch (error) {
    console.error('❌ Upload failed:', error.message);
    process.exit(1);
  }
}

// Usage: node upload.js path/to/file.jpg
const filePath = process.argv[2];
if (!filePath) {
  console.error('Please provide a file path');
  process.exit(1);
}

uploadFile(filePath);
```

### Browser Example

```html
<!DOCTYPE html>
<html>
<head>
    <title>AstraCollab File Upload</title>
</head>
<body>
    <input type="file" id="fileInput" multiple>
    <button onclick="uploadFiles()">Upload Files</button>
    <div id="progress"></div>

    <script type="module">
        import { AstraCollabClient } from 'https://unpkg.com/@astracollab/js@latest/dist/index.mjs';

        const client = new AstraCollabClient({
            apiKey: 'your-api-key-here'
        });

        window.uploadFiles = async function() {
            const fileInput = document.getElementById('fileInput');
            const progressDiv = document.getElementById('progress');
            
            const files = Array.from(fileInput.files);
            
            for (const file of files) {
                try {
                    const fileId = await client.uploadFile({
                        file,
                        fileName: file.name,
                        onProgress: (progress) => {
                            progressDiv.innerHTML = `Uploading ${file.name}: ${progress}%`;
                        }
                    });
                    
                    progressDiv.innerHTML += `<br>✅ ${file.name} uploaded (ID: ${fileId})`;
                } catch (error) {
                    progressDiv.innerHTML += `<br>❌ Failed to upload ${file.name}: ${error.message}`;
                }
            }
        };
    </script>
</body>
</html>
```

## Error Handling

The SDK throws `AstraCollabError` for various scenarios:

```javascript
try {
  const files = await client.listFiles();
} catch (error) {
  switch (error.status) {
    case 401:
      console.error('Invalid API key');
      break;
    case 403:
      console.error('Insufficient permissions');
      break;
    case 404:
      console.error('Resource not found');
      break;
    case 429:
      console.error('Rate limit exceeded');
      break;
    default:
      console.error('An error occurred:', error.message);
  }
}
```

## Configuration

### Update Configuration

```javascript
// Update API key
client.updateConfig({ apiKey: 'new-api-key' });

// Update base URL
client.updateConfig({ baseURL: 'https://custom-api.astracollab.app/v1' });

// Update timeout
client.updateConfig({ timeout: 60000 });
```

### Get Current Configuration

```javascript
const config = client.getConfig();
console.log('Current config:', config);
```

## Best Practices

1. **Environment Variables**: Store API keys in environment variables
2. **Error Handling**: Always implement proper error handling
3. **Progress Tracking**: Use progress callbacks for large file uploads
4. **Rate Limiting**: Respect API rate limits in your application
5. **File Validation**: Validate files before upload (size, type, etc.)

## Browser Support

The SDK works in all modern browsers that support:
- ES6 modules
- Fetch API
- FormData
- Blob API

## Node.js Support

Requires Node.js 18+ for full functionality.

## License

MIT License - see LICENSE file for details.

## Support

Need help with the JavaScript SDK?

- **Documentation**: [docs.astracollab.app](https://docs.astracollab.app)
- **Examples**: Check our [examples page](https://docs.astracollab.app/sdk/examples)
- **API Reference**: Browse the [complete API documentation](https://docs.astracollab.app/api-reference/introduction)
- **Support**: Email us at elias@thenextcreatives.com
