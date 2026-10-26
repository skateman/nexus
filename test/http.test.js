const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const { fetchWithTimeout } = require('../src/utils/http');

const readJson = async (response) => {
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return response.json();
};

test('the deadline remains active while reading a stalled response body', { timeout: 5000 }, async (t) => {
    const server = createServer((_, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"incomplete":');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        const closed = once(server, 'close');
        server.closeAllConnections();
        server.close();
        await closed;
    });

    await assert.rejects(
        fetchWithTimeout(`http://127.0.0.1:${server.address().port}`, {
            method: 'POST',
            timeoutMs: 100,
        }, readJson),
        { name: 'TimeoutError' },
    );
});

test('safe requests retry a transient status and discard its unread body', async (t) => {
    const unavailable = new Response('temporary failure', { status: 503 });
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
        ? unavailable
        : Response.json({ ok: true }));

    assert.deepEqual(await fetchWithTimeout('https://example.test', {}, readJson), { ok: true });
    assert.equal(attempts, 2);
    assert.equal(unavailable.bodyUsed, true);
});

test('safe requests retry transient connection failures', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        if (++attempts < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return Response.json({ recovered: true });
    });

    assert.deepEqual(await fetchWithTimeout('https://example.test', {}, readJson), { recovered: true });
    assert.equal(attempts, 3);
});

test('retries stop after three attempts', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        attempts++;
        return new Response('unavailable', { status: 503 });
    });

    await assert.rejects(fetchWithTimeout('https://example.test', {}, readJson), /HTTP 503/);
    assert.equal(attempts, 3);
});

test('POST requests are never automatically replayed', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        attempts++;
        return new Response('unavailable', { status: 503 });
    });

    await assert.rejects(fetchWithTimeout('https://example.test', { method: 'POST' }, readJson), /HTTP 503/);
    assert.equal(attempts, 1);
});

test('malformed JSON and permanent HTTP errors are not retried', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        attempts++;
        return new Response('not JSON');
    });
    await assert.rejects(fetchWithTimeout('https://example.test', {}, readJson), SyntaxError);
    assert.equal(attempts, 1);

    t.mock.method(globalThis, 'fetch', async () => {
        attempts++;
        return new Response('not found', { status: 404 });
    });
    await assert.rejects(fetchWithTimeout('https://example.test', {}, readJson), /HTTP 404/);
    assert.equal(attempts, 2);
});

test('long Retry-After values defer to a later invocation instead of retrying early', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        attempts++;
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '60' } });
    });

    await assert.rejects(fetchWithTimeout('https://example.test', {}, readJson), /HTTP 429/);
    assert.equal(attempts, 1);
});

test('caller cancellation is preserved without a retry', async (t) => {
    const controller = new AbortController();
    const reason = new Error('Cancelled by caller');
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async (_, { signal }) => {
        attempts++;
        controller.abort(reason);
        signal.throwIfAborted();
    });

    await assert.rejects(fetchWithTimeout('https://example.test', { signal: controller.signal }, readJson), reason);
    assert.equal(attempts, 1);
});

test('HTML and binary bodies are consumed inside the deadline', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>fixture</html>'));
    assert.equal(await fetchWithTimeout('https://example.test', {}, (response) => response.text()), '<html>fixture</html>');

    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([0, 128, 255])));
    const buffer = await fetchWithTimeout('https://example.test', {}, (response) => response.arrayBuffer());
    assert.deepEqual([...new Uint8Array(buffer)], [0, 128, 255]);
});

test('ferry checks preserve token refresh and tolerate missing AIS discovery data', async () => {
    let handler;
    let authenticationCalls = 0;
    let voyageCalls = 0;
    let storedStatus;
    const imports = {
        '@azure/functions': { app: { timer: (_, options) => { handler = options.handler; } } },
        '../utils/storage': {
            storeFile: async (_, __, content) => { storedStatus = JSON.parse(content.toString()); },
        },
        '../utils/http': {
            fetchWithTimeout: async (url, options, readResponse) => {
                let response;
                if (url.includes('/feeds/')) {
                    response = new Response('<rss><item><title>Svi brodovi plove prema redu plovidbe</title></item></rss>');
                } else if (url.endsWith('/Auth/Token')) {
                    assert.equal(options.method, 'POST');
                    response = Response.json({ AccessToken: `fixture-token-${++authenticationCalls}` });
                } else if (url.endsWith('/Routes/SearchVoyages')) {
                    assert.equal(options.method, 'POST');
                    response = ++voyageCalls === 1
                        ? new Response('expired', { status: 401 })
                        : Response.json([{ Status: 40, Ship: { ShipName: 'NEW_SHIP' } }]);
                } else if (url.includes('/bounding-box?')) {
                    response = Response.json(null);
                } else if (url.includes('/latest-position?')) {
                    response = Response.json([]);
                } else {
                    assert.fail(`Unexpected URL: ${url}`);
                }
                return readResponse(response);
            },
        },
    };
    const filename = resolve(__dirname, '../src/functions/jadrolinija.js');
    runInNewContext(readFileSync(filename, 'utf8'), {
        module: { exports: {} },
        require: (name) => {
            assert.ok(name in imports, `Unexpected import: ${name}`);
            return imports[name];
        },
        process: { env: { AISFRIENDS_TOKEN: 'fixture-token' } },
        crypto: { randomUUID: () => 'fixture-session' },
        Buffer,
    }, { filename });

    await handler(null, { log() {}, error: (message) => assert.fail(message) });
    assert.equal(authenticationCalls, 2);
    assert.equal(voyageCalls, 2);
    assert.equal(storedStatus.healthy, true);
    assert.equal(storedStatus.routes.merag_valbiska.disrupted, false);
    assert.equal(storedStatus.routes.merag_valbiska.sources.voyager2.departuresFound, 1);
    assert.deepEqual(storedStatus.routes.merag_valbiska.sources.voyager2.ships, ['NEW_SHIP']);
    assert.equal(storedStatus.routes.merag_valbiska.sources.aisfriends.disrupted, null);
});

const loadTelegram = (callApi, signal = AbortSignal) => {
    const module = { exports: {} };
    const filename = resolve(__dirname, '../src/utils/telegram.js');
    runInNewContext(readFileSync(filename, 'utf8'), {
        module,
        AbortSignal: signal,
        require: (name) => {
            assert.equal(name, 'telegraf');
            return { Telegraf: class {
                constructor(token) {
                    assert.equal(token, 'test-token');
                    this.telegram = { callApi };
                }
            } };
        },
    }, { filename });
    return module.exports;
};

test('Telegram sends retain their payload and pass a cancellation signal', async () => {
    const sent = { message_id: 123 };
    const telegram = loadTelegram(async (method, payload, { signal }) => {
        assert.equal(method, 'sendMessage');
        assert.equal(payload.chat_id, 'test-chat');
        assert.equal(payload.text, 'Hello');
        assert.equal(payload.parse_mode, 'HTML');
        assert.equal(payload.disable_notification, true);
        assert.ok(signal instanceof AbortSignal);
        return sent;
    });
    const result = await telegram.sendMessage('test-token', 'test-chat', 'Hello', { disableNotification: true });
    assert.equal(result.ok, true);
    assert.equal(result.result, sent);
});

test('Telegram timeouts propagate without replaying the send', async () => {
    let attempts = 0;
    const telegram = loadTelegram(async (_, __, { signal }) => {
        attempts++;
        signal.throwIfAborted();
    }, {
        timeout: (milliseconds) => {
            assert.equal(milliseconds, 15000);
            return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
        },
    });

    await assert.rejects(telegram.sendMessage('test-token', 'test-chat', 'Hello'), /Failed to send Telegram message: Timed out/);
    assert.equal(attempts, 1);
});
