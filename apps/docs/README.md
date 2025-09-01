# Introduction

This repository contains the official documentation for AstraCollab, a powerful storage solution that combines the simplicity of Google Drive with enterprise-grade API access.

## About AstraCollab

AstraCollab provides:
- **File Upload & Management**: Upload files with progress tracking, multipart uploads for large files, and real-time status updates
- **API Access**: Full REST API with authentication, rate limiting, and comprehensive documentation
- **SDK & Libraries**: Official SDKs for Next.js and JavaScript with React hooks and components
- **Billing & Usage**: Per-user and per-storage billing with usage tracking and overage management

## Documentation Structure

- **Guides**: Getting started, development setup, and feature guides
- **SDK Documentation**: Next.js and JavaScript SDK documentation with examples
- **API Reference**: Complete API documentation with all endpoints
- **Features**: Detailed guides for file upload, storage management, billing, and API keys

## Development

### Prerequisites

- Node.js 18+
- Mintlify CLI

### Local Development

1. Install the Mintlify CLI:
   ```bash
   npm i -g mint
   ```

2. Start the development server:
   ```bash
   mint dev
   ```

3. View your local preview at `http://localhost:3000`

### Publishing Changes

Changes are automatically deployed to production when pushed to the main branch. The documentation is hosted on Mintlify and updates automatically.

## Repository Structure

```
├── docs.json              # Mintlify configuration
├── index.mdx              # Homepage
├── quickstart.mdx         # Quickstart guide
├── development.mdx        # Development setup
├── api-reference/         # API documentation
├── sdk/                   # SDK documentation
├── features/              # Feature guides
├── images/                # Documentation images
└── logo/                  # Brand assets
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `mint dev`
5. Submit a pull request

## Resources

- **Support**: elias@thenextcreatives.com

## License

This documentation is part of the AstraCollab project and is subject to the same license terms.
