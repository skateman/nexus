const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_ERRORS = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

const fetchWithTimeout = async (url, { timeoutMs = 15000, ...options } = {}, readResponse) => {
    const retrySafe = ['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase());

    for (let attempt = 0; attempt < 3; attempt++) {
        options.signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => {
            controller.abort(new DOMException('HTTP request timed out', 'TimeoutError'));
        }, timeoutMs);
        let response;
        let retryDelay;

        try {
            response = await fetch(url, { ...options, signal: controller.signal });
            if (!retrySafe || attempt === 2 || !RETRYABLE_STATUS.has(response.status)) {
                return await readResponse(response);
            }
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
                retryDelay = /^\d+$/.test(retryAfter)
                    ? Number(retryAfter) * 1000
                    : Math.max(0, Date.parse(retryAfter) - Date.now());
                if (retryDelay > 5000) return await readResponse(response);
                if (!Number.isFinite(retryDelay)) retryDelay = undefined;
            }
            await response.body?.cancel();
        } catch (error) {
            if (options.signal?.aborted) throw options.signal.reason;
            if (controller.signal.aborted) error = controller.signal.reason;
            const transient = error.name === 'TimeoutError'
                || RETRYABLE_NETWORK_ERRORS.has(error.cause?.code || error.code);
            if (!retrySafe || attempt === 2 || !transient) throw error;
        } finally {
            if (response?.body && !response.bodyUsed) {
                await response.body.cancel().catch(() => {});
            }
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
        }

        const delay = retryDelay ?? (250 * (2 ** attempt) + Math.floor(Math.random() * 100));
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
};

module.exports = { fetchWithTimeout };
