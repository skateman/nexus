const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require("@azure/identity");

const getClient = async (containerName, blobName) => {
    // Apparently `AzureWebJobsStorage` is no longer set in production and the new way
    // of doing things is to use `AzureWebJobsStorage__blobServiceUri` with a managed identity.
    // Unfortunately, when this was introduced, no one actually thought about updating Azurite
    // to match this change and it is not possible to use the managed identity without HTTPS.
    // So we need to play clown here and do a conditional logic to check if we are running in
    // development or production and use the appropriate method to create the BlobServiceClient.
    const connectionString = process.env.AzureWebJobsStorage;
    let blobServiceClient;
    if (connectionString && connectionString.includes('UseDevelopmentStorage=true')) {
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
        const blobUri = process.env.AzureWebJobsStorage__blobServiceUri;
        const credential = new DefaultAzureCredential();
        blobServiceClient = new BlobServiceClient(blobUri, credential);
    }

    const container = blobServiceClient.getContainerClient(containerName);
    await container.createIfNotExists();

    return container.getBlockBlobClient(blobName);
};

const storeFile = async (containerName, blobName, blobContent, blobContentType, expiryDate = null) => {
    const client = await getClient(containerName, blobName);

    const uploadOptions = {
        blobHTTPHeaders: { blobContentType },
        metadata: expiryDate ? { expiryDate: expiryDate.toISOString() } : {}
    };

    await client.upload(blobContent, blobContent.length, uploadOptions);

    console.log(`File stored successfully: ${blobName} in container ${containerName}`);
};

const getFile = async (containerName, blobName) => {
    try {
        const client = await getClient(containerName, blobName);

        // Check if blob exists and is not expired
        const properties = await client.getProperties();
        const expiryDate = properties.metadata?.expiryDate;

        if (expiryDate && new Date(expiryDate) < new Date()) {
            console.log(`File ${blobName} has expired`);
            return null;
        }

        const downloadResponse = await client.download();
        const contentBuffer = await streamToBuffer(downloadResponse.readableStreamBody);

        return {
            content: contentBuffer.toString(),
            contentType: properties.contentType,
            metadata: properties.metadata
        };
    } catch (error) {
        if (error.statusCode === 404) {
            console.log(`File ${blobName} not found in container ${containerName}`);
            return null;
        }
        throw error;
    }
};

// Helper function to convert stream to buffer
const streamToBuffer = async (readableStream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => {
            chunks.push(data instanceof Buffer ? data : Buffer.from(data));
        });
        readableStream.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on('error', reject);
    });
};

module.exports = { storeFile, getFile };
