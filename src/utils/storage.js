const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require("@azure/identity");

const storeFile = async (containerName, blobName, blobContent, blobContentType, expiryDate = null) => {
    let blobServiceClient;

    // Apparently `AzureWebJobsStorage` is no longer set in production and the new way
    // of doing things is to use `AzureWebJobsStorage__blobServiceUri` with a managed identity.
    // Unfortunately, when this was introduced, no one actually thought about updating Azurite
    // to match this change and it is not possible to use the managed identity without HTTPS.
    // So we need to play clown here and do a conditional logic to check if we are running in
    // development or production and use the appropriate method to create the BlobServiceClient.
    const connectionString = process.env.AzureWebJobsStorage;
    if (connectionString && connectionString.includes('UseDevelopmentStorage=true')) {
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
        const blobUri = process.env.AzureWebJobsStorage__blobServiceUri;
        const credential = new DefaultAzureCredential();
        blobServiceClient = new BlobServiceClient(blobUri, credential);
    }

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    const uploadOptions = {
        blobHTTPHeaders: { blobContentType },
        metadata: expiryDate ? { expiryDate: expiryDate.toISOString() } : {}
    };

    await blockBlobClient.upload(blobContent, blobContent.length, uploadOptions);

    console.log(`File stored successfully: ${blobName} in container ${containerName}`);
};

module.exports = { storeFile };
