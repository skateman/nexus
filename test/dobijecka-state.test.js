const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const loadDobijecka = ({
    now = '2026-10-25T23:30:00Z',
    marker = null,
    lookupError,
    telegramError,
    storeError,
    advanceAfterPage = 0,
} = {}) => {
    let handler;
    let clock = new Date(now).getTime();
    const calls = { pdf: 0, parsed: 0, messages: [], stored: [] };
    const pdfUrl = 'https://example.test/OP-Odmena-za-dobiti-FB_26102026.pdf';
    class Clock extends Date {
        constructor(...args) {
            super(...(args.length ? args : [clock]));
        }
        static now() {
            return clock;
        }
    }
    const imports = {
        '@azure/functions': { app: { timer: (_, options) => { handler = options.handler; } } },
        '../utils/storage': {
            getFile: async () => {
                if (lookupError) throw lookupError;
                return marker === null ? null : { content: marker };
            },
            storeFile: async (container, blob, content, contentType, expiryDate) => {
                if (storeError) throw storeError;
                calls.stored.push({ container, blob, content, contentType, expiryDate });
            },
        },
        '../utils/telegram': {
            sendMessage: async (_, __, message) => {
                if (telegramError) throw telegramError;
                calls.messages.push(message);
                return { result: { message_id: 123 } };
            },
        },
        'pdf-parse': async () => {
            calls.parsed++;
            return { text: 'období od 12:00 do 16:00 hod.' };
        },
        jsdom: { JSDOM: class {
            constructor() {
                this.window = { document: { querySelector: () => ({ href: pdfUrl }) } };
            }
        } },
    };
    const globals = {
        process: { env: { DOBIJECKA_TG_TOKEN: 'test-token', DOBIJECKA_TG_CHAT_ID: 'test-chat' } },
        console: { error() {} },
        Date: Clock,
        Buffer,
        AbortController,
        DOMException,
        setTimeout,
        clearTimeout,
        fetch: async (url) => {
            if (url === 'https://www.mujkaktus.cz/') {
                return new Response('homepage', { headers: { 'Set-Cookie': 'fixture=value; Path=/' } });
            }
            if (url === 'https://www.mujkaktus.cz/chces-pridat') {
                clock += advanceAfterPage;
                return new Response('<html>fixture</html>');
            }
            assert.equal(url, pdfUrl);
            calls.pdf++;
            return new Response(new Uint8Array([1, 2, 3]));
        },
    };
    const load = (filename) => {
        const module = { exports: {} };
        runInNewContext(readFileSync(filename, 'utf8'), {
            ...globals,
            module,
            require: (name) => {
                if (name in imports) return imports[name];
                assert.ok(name.startsWith('.'), `Unexpected import: ${name}`);
                return load(require.resolve(resolve(dirname(filename), name)));
            },
        }, { filename });
        return module.exports;
    };
    const helpers = load(resolve(__dirname, '../src/functions/dobijecka.js'));
    return { helpers, calls, run: () => handler(null, { log() {} }) };
};

test('promotion dates use Prague calendar days through both daylight-saving transitions', () => {
    const { helpers } = loadDobijecka();
    for (const [instant, day] of [
        ['2026-01-01T23:30:00Z', '2026-01-02'],
        ['2026-03-28T23:30:00Z', '2026-03-29'],
        ['2026-03-29T22:30:00Z', '2026-03-30'],
        ['2026-10-24T22:30:00Z', '2026-10-25'],
        ['2026-10-25T22:30:00Z', '2026-10-25'],
        ['2026-10-25T23:30:00Z', '2026-10-26'],
    ]) {
        assert.equal(helpers.getPromotionDate(new Date(instant)), day);
    }
    assert.ok(helpers.isToday('https://example.test/OP-Odmena-za-dobiti-FB_26102026.pdf'));
    assert.ok(!helpers.isToday('https://example.test/OP-Odmena-za-dobiti-FB_25102026.pdf'));
});

test('unknown notification history stops before PDF extraction or sending', async () => {
    const fixture = loadDobijecka({ lookupError: new Error('Storage unavailable') });
    await assert.rejects(fixture.run(), /Storage unavailable/);
    assert.equal(fixture.calls.pdf, 0);
    assert.equal(fixture.calls.parsed, 0);
    assert.equal(fixture.calls.messages.length, 0);
    assert.equal(fixture.calls.stored.length, 0);
});

test('a marker for the current Prague day suppresses duplicate notifications', async () => {
    const fixture = loadDobijecka({ marker: '2026-10-26\n' });
    await fixture.run();
    assert.equal(fixture.calls.pdf, 0);
    assert.equal(fixture.calls.messages.length, 0);
    assert.equal(fixture.calls.stored.length, 0);
});

test('a missing or previous-day marker allows a successful send and Prague-date checkpoint', async () => {
    for (const marker of [null, '2026-10-25']) {
        const fixture = loadDobijecka({ marker });
        await fixture.run();
        assert.equal(fixture.calls.pdf, 1);
        assert.equal(fixture.calls.messages.length, 1);
        assert.ok(fixture.calls.messages[0].includes('26. 10. 2026 0:30:00'));
        assert.equal(fixture.calls.stored.length, 1);
        assert.equal(fixture.calls.stored[0].container, 'nexus-results');
        assert.equal(fixture.calls.stored[0].blob, 'dobijecka-last.txt');
        assert.equal(fixture.calls.stored[0].content, '2026-10-26');
        assert.equal(fixture.calls.stored[0].contentType, 'text/plain');
        assert.equal(fixture.calls.stored[0].expiryDate.getTime(), new Date('2026-10-26T23:30:00Z').getTime());
    }
});

test('the invocation uses one day snapshot even if the clock crosses midnight', async () => {
    const fixture = loadDobijecka({ now: '2026-10-26T22:59:30Z', advanceAfterPage: 60000 });
    await fixture.run();
    assert.equal(fixture.calls.messages.length, 1);
    assert.equal(fixture.calls.stored[0].content, '2026-10-26');
});

test('failed Telegram sends do not write a successful-delivery marker', async () => {
    const fixture = loadDobijecka({ telegramError: new Error('Telegram unavailable') });
    await assert.rejects(fixture.run(), /Telegram unavailable/);
    assert.equal(fixture.calls.stored.length, 0);
});

test('delivery-marker write failures remain visible to the timer invocation', async () => {
    const fixture = loadDobijecka({ storeError: new Error('Marker unavailable') });
    await assert.rejects(fixture.run(), /Marker unavailable/);
    assert.equal(fixture.calls.messages.length, 1);
});
