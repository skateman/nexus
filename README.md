# nexus
Azure Functions for (Home) Automation

## Prerequisites

- [Node.js](https://nodejs.org/) version 18 or higher
- [Azure Functions Core Tools](https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local)
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli) (for deployment)

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Install Azure Functions Core Tools globally (if not already installed):
   ```bash
   npm install -g azure-functions-core-tools@4 --unsafe-perm true
   ```

3. Start the Azure Functions runtime locally:
   ```bash
   npm start
   ```

## Development

- **Start**: `npm start` - Runs the Azure Functions runtime locally

## Function Endpoints

When running locally, your functions will be available at:

- `http://localhost:7071/api/tankarta` - GET/POST - Simple scraper for Tankarta

## Configuration

- `host.json` - Azure Functions host configuration
- `local.settings.json` - Local development settings (not committed to source control)

## Deployment

1. Create an Azure Function App
2. Deploy using Azure Functions Core Tools:
   ```bash
   func azure functionapp publish <APP_NAME>
   ```

Or use the Azure CLI:
```bash
az functionapp deployment source config-zip --resource-group <RESOURCE_GROUP> --name <APP_NAME> --src <ZIP_FILE>
```

## Environment Variables

Add these to your `local.settings.json` for local development or configure them in Azure for production:

- `AzureWebJobsStorage` - Azure Storage connection string
- `FUNCTIONS_WORKER_RUNTIME` - Set to "node"

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request
