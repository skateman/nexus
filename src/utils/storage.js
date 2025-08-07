const { BlobServiceClient } = require('@azure/storage-blob');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require("@azure/identity");

const getClient = (client, options = []) => {
    const connectionString = process.env.AzureWebJobsStorage;

    // Apparently `AzureWebJobsStorage` is no longer set in production and the new way
    // of doing things is to use `AzureWebJobsStorage__xxxServiceUri` with a managed identity.
    // Unfortunately, when this was introduced, no one actually thought about updating Azurite
    // to match this change and it is not possible to use the managed identity without HTTPS.
    // So we need to play clown here and do a conditional logic to check if we are running in
    // development or production and use the appropriate method to create the client.

    if (connectionString && connectionString.includes('UseDevelopmentStorage=true')) {
        return client.fromConnectionString(connectionString, ...options);
    }

    const service = client.name.replace(/(ServiceClient|Client)$/, '').toLowerCase();
    const uri = process.env[`AzureWebJobsStorage__${service}ServiceUri`];

    return new client(uri, ...options, new DefaultAzureCredential());
};

const getBlobClient = async (containerName, blobName) => {
    const container = getClient(BlobServiceClient).getContainerClient(containerName);
    await container.createIfNotExists();

    return container.getBlockBlobClient(blobName);
};

const storeFile = async (containerName, blobName, blobContent, blobContentType, expiryDate = null) => {
    const client = await getBlobClient(containerName, blobName);

    const uploadOptions = {
        blobHTTPHeaders: { blobContentType },
        metadata: expiryDate ? { expiryDate: expiryDate.toISOString() } : {}
    };

    await client.upload(blobContent, blobContent.length, uploadOptions);

    console.log(`File stored successfully: ${blobName} in container ${containerName}`);
};

const getFile = async (containerName, blobName) => {
    try {
        const client = await getBlobClient(containerName, blobName);

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

const getTableClient = async (tableName) => {
    const client = getClient(TableClient, [tableName]);
    await client.createTable().catch(err => {
        // Ignore error if table already exists
        if (err.statusCode !== 409) throw err;
    });

    return client;
};

const getLastRow = async (tableName, partitionKey, orderByRowKey = true) => {
    try {
        const tableClient = await getTableClient(tableName);

        const entities = tableClient.listEntities({
            filter: `PartitionKey eq '${partitionKey}'`
        });

        let lastEntity = null;
        for await (const entity of entities) {
            if (!lastEntity || (orderByRowKey && entity.rowKey > lastEntity.rowKey)) {
                lastEntity = entity;
            }
        }

        return lastEntity;
    } catch (error) {
        if (error.statusCode === 404) {
            return null;
        }
        throw error;
    }
};

const storeRow = async (tableName, partitionKey, rowKey, data) => {
    const tableClient = await getTableClient(tableName);

    const entity = {
        partitionKey,
        rowKey,
        ...data
    };

    await tableClient.upsertEntity(entity);
    console.log(`Row stored successfully: ${partitionKey}/${rowKey} in table ${tableName}`);
};

module.exports = { storeFile, getFile, getTableClient, getLastRow, storeRow };
