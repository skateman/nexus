const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const loadStorage = ({ development = false, containerInit = async () => {}, tableInit = async () => {} } = {}) => {
    const calls = { credentials: [], blobs: [], tables: [], containers: [], containerInit: [], tableInit: [], uploads: [] };
    class DefaultAzureCredential {
        constructor(options) {
            calls.credentials.push({ credential: this, options });
        }
    }
    class BlobServiceClient {
        constructor(uri, credential) {
            calls.blobs.push({ uri, credential });
        }
        static fromConnectionString(value) {
            return new BlobServiceClient(value);
        }
        getContainerClient(name) {
            calls.containers.push(name);
            return {
                async createIfNotExists() {
                    calls.containerInit.push(name);
                    await containerInit(name);
                },
                getBlockBlobClient(blobName) {
                    return {
                        async upload(content) {
                            calls.uploads.push({ name, blobName, content });
                        },
                    };
                },
            };
        }
    }
    class TableClient {
        constructor(uri, name, credential) {
            this.name = name;
            calls.tables.push({ client: this, uri, name, credential });
        }
        static fromConnectionString(value, name) {
            return new TableClient(value, name);
        }
        async createTable() {
            calls.tableInit.push(this.name);
            await tableInit(this.name);
        }
    }
    const imports = {
        '@azure/storage-blob': { BlobServiceClient },
        '@azure/data-tables': { TableClient },
        '@azure/identity': { DefaultAzureCredential },
    };
    const module = { exports: {} };
    const filename = resolve(__dirname, '../src/utils/storage.js');
    runInNewContext(readFileSync(filename, 'utf8'), {
        module,
        require: (name) => {
            assert.ok(name in imports, `Unexpected import: ${name}`);
            return imports[name];
        },
        process: { env: development ? {
            AzureWebJobsStorage: 'UseDevelopmentStorage=true',
        } : {
            AzureWebJobsStorage__blobServiceUri: 'https://example.blob.core.windows.net',
            AzureWebJobsStorage__tableServiceUri: 'https://example.table.core.windows.net',
            AZURE_CLIENT_ID: 'test-managed-identity',
        } },
        console: { log() {} },
    }, { filename });
    return { storage: module.exports, calls };
};

test('managed identity credentials and clients are reused across resources', async () => {
    const { storage, calls } = loadStorage();
    await storage.storeFile('results', 'one.txt', 'one', 'text/plain');
    await storage.storeFile('results', 'two.txt', 'two', 'text/plain');
    const first = await storage.getTableClient('prices');
    assert.equal(await storage.getTableClient('prices'), first);
    await storage.getTableClient('alerts');

    assert.equal(calls.credentials.length, 1);
    assert.equal(calls.credentials[0].options.managedIdentityClientId, 'test-managed-identity');
    assert.equal(calls.blobs.length, 1);
    assert.equal(calls.blobs[0].uri, 'https://example.blob.core.windows.net');
    assert.equal(calls.blobs[0].credential, calls.credentials[0].credential);
    assert.equal(calls.tables.length, 2);
    for (const table of calls.tables) {
        assert.equal(table.uri, 'https://example.table.core.windows.net');
        assert.equal(table.credential, calls.credentials[0].credential);
    }
    assert.deepEqual(calls.containerInit, ['results']);
    assert.deepEqual(calls.tableInit, ['prices', 'alerts']);
});

test('Azurite still uses connection strings without constructing credentials', async () => {
    const { storage, calls } = loadStorage({ development: true });
    await storage.storeFile('results', 'one.txt', 'one', 'text/plain');
    await storage.getTableClient('prices');

    assert.equal(calls.credentials.length, 0);
    assert.equal(calls.blobs[0].uri, 'UseDevelopmentStorage=true');
    assert.equal(calls.tables[0].uri, 'UseDevelopmentStorage=true');
    assert.equal(calls.tables[0].name, 'prices');
});

test('concurrent blob writes share initialization and keep containers separate', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { storage, calls } = loadStorage({ containerInit: () => pending });
    const writes = Promise.all([
        storage.storeFile('results', 'one.txt', 'one', 'text/plain'),
        storage.storeFile('results', 'two.txt', 'two', 'text/plain'),
        storage.storeFile('other', 'three.txt', 'three', 'text/plain'),
    ]);
    assert.deepEqual(calls.containerInit, ['results', 'other']);
    assert.equal(calls.uploads.length, 0);
    release();
    await writes;
    assert.equal(calls.uploads.length, 3);
    assert.equal(calls.blobs.length, 1);
});

test('failed container initialization is retried on the next operation', async () => {
    let attempts = 0;
    const { storage, calls } = loadStorage({
        containerInit: async () => {
            if (++attempts === 1) throw new Error('Temporary container failure');
        },
    });
    await assert.rejects(storage.storeFile('results', 'one.txt', 'one', 'text/plain'), /Temporary/);
    await storage.storeFile('results', 'one.txt', 'one', 'text/plain');
    assert.equal(calls.containerInit.length, 2);
    assert.equal(calls.blobs.length, 1);
    assert.equal(calls.uploads.length, 1);
});

test('concurrent table reads share initialization and return the same client', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { storage, calls } = loadStorage({ tableInit: () => pending });
    const first = storage.getTableClient('prices');
    const second = storage.getTableClient('prices');
    assert.deepEqual(calls.tableInit, ['prices']);
    release();
    assert.equal(await first, await second);
    assert.equal(calls.tables.length, 1);
});

test('existing tables are initialized only once', async () => {
    const { storage, calls } = loadStorage({
        tableInit: async () => {
            throw Object.assign(new Error('Already exists'), { statusCode: 409 });
        },
    });
    assert.equal(await storage.getTableClient('prices'), await storage.getTableClient('prices'));
    assert.deepEqual(calls.tableInit, ['prices']);
});

test('failed table initialization is evicted instead of caching a rejection', async () => {
    let attempts = 0;
    const { storage, calls } = loadStorage({
        tableInit: async () => {
            if (++attempts === 1) throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
        },
    });
    await assert.rejects(storage.getTableClient('prices'), /Unavailable/);
    const client = await storage.getTableClient('prices');
    assert.equal(client, calls.tables[1].client);
    assert.equal(calls.tableInit.length, 2);
});
