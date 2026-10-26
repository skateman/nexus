const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const { odata } = require('@azure/data-tables');

const loadModule = (path, imports, globals = {}) => {
    const filename = resolve(__dirname, '..', path);
    const module = { exports: {} };
    runInNewContext(readFileSync(filename, 'utf8'), {
        module,
        require: (name) => {
            assert.ok(name in imports, `Unexpected import: ${name}`);
            return imports[name];
        },
        process: { env: { AzureWebJobsStorage: 'UseDevelopmentStorage=true' } },
        console: { log() {} },
        ...globals,
    }, { filename });
    return module.exports;
};

const loadStorage = (client) => loadModule('src/utils/storage.js', {
    '@azure/storage-blob': { BlobServiceClient: {} },
    '@azure/data-tables': {
        TableClient: { fromConnectionString: () => ({ createTable: async () => {}, ...client }) },
        odata,
    },
    '@azure/identity': { DefaultAzureCredential: class {} },
});

test('history queries filter the requested partition and choose its greatest row key', async () => {
    const latest = { partitionKey: "O'Brien", rowKey: '2026-10-26', Price: 35 };
    const storage = loadStorage({
        async *listEntities(options) {
            assert.equal(options.queryOptions.filter, "PartitionKey eq 'O''Brien'");
            assert.equal(options.filter, undefined);
            yield latest;
            yield { partitionKey: "O'Brien", rowKey: '2026-10-25', Price: 34 };
        },
    });

    assert.equal(await storage.getLastRow('prices', "O'Brien"), latest);
});

test('empty history returns null', async () => {
    const storage = loadStorage({ async *listEntities() {} });
    assert.equal(await storage.getLastRow('prices', 'price'), null);
});

test('fixed-key reads use getEntity without enumerating the table', async () => {
    const row = { partitionKey: 'daily-check', rowKey: 'latest', CheckedDate: '2026-10-26' };
    const storage = loadStorage({
        async getEntity(partitionKey, rowKey) {
            assert.equal(partitionKey, 'daily-check');
            assert.equal(rowKey, 'latest');
            return row;
        },
        listEntities() {
            assert.fail('Point reads must not enumerate entities');
        },
    });

    assert.equal(await storage.getRow('tankarta', 'daily-check', 'latest'), row);
});

test('missing rows return null but other storage failures propagate', async () => {
    const missing = loadStorage({
        async getEntity() {
            throw Object.assign(new Error('Not found'), { statusCode: 404 });
        },
    });
    assert.equal(await missing.getRow('state', 'symbol', 'current'), null);

    const unavailable = loadStorage({
        async getEntity() {
            throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
        },
        async *listEntities() {
            throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
        },
    });
    await assert.rejects(unavailable.getRow('state', 'symbol', 'current'), /Unavailable/);
    await assert.rejects(unavailable.getLastRow('prices', 'price'), /Unavailable/);
});

test('Tankarta reads its daily checkpoint by its fixed key and skips a completed day', async () => {
    let handler;
    let pointReads = 0;
    loadModule('src/functions/tankarta.js', {
        '@azure/functions': { app: { timer: (_, options) => { handler = options.handler; } } },
        'puppeteer-core': { connect: () => assert.fail('Completed days must not scrape') },
        '../utils/storage': {
            getLastRow: async (table, partition) => {
                assert.equal(table, 'tankarta');
                assert.equal(partition, 'price');
                return { Price: 35 };
            },
            getRow: async (table, partition, row) => {
                assert.equal(table, 'tankarta');
                assert.equal(partition, 'daily-check');
                assert.equal(row, 'latest');
                pointReads++;
                return { CheckedDate: new Date().toISOString().split('T')[0], Price: 35, Credit: '100' };
            },
        },
    });

    await handler(null, { log() {} });
    assert.equal(pointReads, 1);
});

test('Deathcross reads only the current state for the configured symbol', async () => {
    let handler;
    let pointReads = 0;
    loadModule('src/functions/deathcross.js', {
        '@azure/functions': { app: { timer: (_, options) => { handler = options.handler; } } },
        '../utils/telegram': { sendMessage: () => assert.fail('Unchanged regimes must not alert') },
        '../utils/storage': {
            getRow: async (table, partition, row) => {
                assert.equal(table, 'deathcross');
                assert.equal(partition, 'GSPC');
                assert.equal(row, 'current');
                pointReads++;
                return { State: 'imminent' };
            },
            storeRow: async () => {},
        },
    }, {
        process: { env: { DEATHCROSS_TG_TOKEN: 'test-token', DEATHCROSS_TG_CHAT_ID: 'test-chat' } },
        fetch: async () => ({
            ok: true,
            json: async () => ({
                chart: { result: [{
                    timestamp: Array.from({ length: 220 }, (_, i) => 1700000000 + i * 86400),
                    indicators: { quote: [{ close: Array(220).fill(100) }] },
                }] },
            }),
        }),
    });

    await handler(null, { log() {} });
    assert.equal(pointReads, 1);
});
