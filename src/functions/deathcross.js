const { app } = require('@azure/functions');
const { sendMessage } = require('../utils/telegram');
const { getLastRow, storeRow } = require('../utils/storage');

// The index whose 50-day vs 200-day moving-average relationship we track.
// Yahoo's chart endpoint expects the caret URL-encoded (^GSPC -> %5EGSPC).
const SYMBOL = process.env.DEATHCROSS_SYMBOL || '^GSPC';

// The two moving averages that define the cross, and the window we fit a slope
// to when projecting how soon an *imminent* cross would complete.
const SHORT = 50;
const LONG = 200;
const SLOPE_WINDOW = 10;

// "Imminent" tuning. We warn *before* the cross actually happens when either:
//   - the 50-day sits within IMMINENT_PCT percent of the 200-day, or
//   - the recent shrink rate of the gap projects a cross within IMMINENT_DAYS
//     trading days.
const IMMINENT_PCT = process.env.DEATHCROSS_IMMINENT_PCT ? parseFloat(process.env.DEATHCROSS_IMMINENT_PCT) : 0.5;
const IMMINENT_DAYS = process.env.DEATHCROSS_IMMINENT_DAYS ? parseInt(process.env.DEATHCROSS_IMMINENT_DAYS, 10) : 10;

const TABLE = 'deathcross';

// Pull ~2 years of daily closes so there is always enough history for a 200-day
// average (plus the trailing window used for the slope projection).
const fetchDailyCloses = async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?range=2y&interval=1d`;

    // Yahoo rejects the default undici user-agent, so mimic a browser like the
    // other scrapers in this project do.
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) {
        throw new Error(`Yahoo Finance returned HTTP ${response.status} for ${SYMBOL}`);
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
        throw new Error('Unexpected Yahoo Finance payload: missing timestamps/closes');
    }

    // Yahoo occasionally returns a null close for a holiday or a bad tick; drop
    // those so the averages only ever see real trading days.
    return timestamps
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().split('T')[0], close: closes[i] }))
        .filter((row) => typeof row.close === 'number' && isFinite(row.close));
};

// Simple moving average of `period` values ending at (and including) `index`.
// Returns null when there is not enough history before `index`.
const smaAt = (values, period, index) => {
    if (index + 1 < period) return null;
    let sum = 0;
    for (let i = index + 1 - period; i <= index; i++) sum += values[i];
    return sum / period;
};

// Turn a close-price series into the current cross state plus the numbers used
// to describe it. Pure function so it can be exercised without Azure/Telegram.
const analyze = (series) => {
    const closes = series.map((r) => r.close);
    const n = closes.length;

    // Need the 200-day average for today *and* yesterday to detect a same-day
    // cross, and SLOPE_WINDOW extra days to measure the gap's trend.
    const required = LONG + SLOPE_WINDOW + 1;
    if (n < required) {
        throw new Error(`Not enough data: have ${n} trading days, need at least ${required}`);
    }

    const last = n - 1;
    const sma50 = smaAt(closes, SHORT, last);
    const sma200 = smaAt(closes, LONG, last);
    const sma50Prev = smaAt(closes, SHORT, last - 1);
    const sma200Prev = smaAt(closes, LONG, last - 1);

    const gap = sma50 - sma200;
    const gapPrev = sma50Prev - sma200Prev;

    // A death cross is the day the 50-day slips from >= to < the 200-day; the
    // reverse (golden cross) is used to announce a recovery.
    const crossedDown = gapPrev >= 0 && gap < 0;
    const crossedUp = gapPrev <= 0 && gap > 0;

    // Distance to the cross, expressed as a share of the slow average.
    const gapPct = (gap / sma200) * 100;

    // Average daily change of the gap over the trailing window. While the gap is
    // positive but shrinking, extrapolate a linear ETA to the crossing point.
    const gapWindowAgo = smaAt(closes, SHORT, last - SLOPE_WINDOW) - smaAt(closes, LONG, last - SLOPE_WINDOW);
    const dailySlope = (gap - gapWindowAgo) / SLOPE_WINDOW;
    const daysToCross = gap > 0 && dailySlope < 0 ? gap / -dailySlope : null;

    let regime;
    if (gap < 0) {
        regime = 'bearish'; // 50-day below 200-day: a death cross is in effect
    } else if (gapPct <= IMMINENT_PCT || (daysToCross !== null && daysToCross <= IMMINENT_DAYS)) {
        regime = 'imminent'; // still above, but closing in fast
    } else {
        regime = 'bullish'; // comfortably above
    }

    return {
        date: series[last].date,
        close: closes[last],
        sma50,
        sma200,
        gap,
        gapPct,
        crossedDown,
        crossedUp,
        dailySlope,
        daysToCross,
        regime,
    };
};

// Alert only on meaningful transitions so a lingering regime is not re-announced
// on every run:
//   * anything -> bearish          => death cross (just formed or already active)
//   * bearish  -> anything else    => golden cross / recovery
//   * bullish  -> imminent         => early warning
// A silent imminent -> bullish back-off intentionally produces no alert.
const decideEvent = (prevState, regime) => {
    if (prevState !== 'bearish' && regime === 'bearish') return 'death_cross';
    if (prevState === 'bearish' && regime !== 'bearish') return 'golden_cross';
    if (prevState !== 'imminent' && prevState !== 'bearish' && regime === 'imminent') return 'imminent';
    return null;
};

const fmt = (x) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (x) => (x >= 0 ? '+' : '') + fmt(x);

const buildMessage = (event, m) => {
    const name = SYMBOL === '^GSPC' ? 'S&P 500' : SYMBOL;

    const stats = [
        `📈 Close: <b>${fmt(m.close)}</b>`,
        `50-day SMA: <b>${fmt(m.sma50)}</b>`,
        `200-day SMA: <b>${fmt(m.sma200)}</b>`,
        `Gap (50−200): <b>${signed(m.gap)}</b> (${m.gapPct >= 0 ? '+' : ''}${m.gapPct.toFixed(2)}%)`,
    ];

    let header;
    let note;
    if (event === 'death_cross') {
        header = m.crossedDown
            ? `💀 <b>${name}: DEATH CROSS just formed</b>`
            : `💀 <b>${name}: death cross in effect</b>`;
        note = 'The 50-day moving average is <b>below</b> the 200-day — a classic bearish signal.';
    } else if (event === 'imminent') {
        header = `⚠️ <b>${name}: death cross imminent</b>`;
        const eta = m.daysToCross !== null ? ` (~${Math.round(m.daysToCross)} trading days at the current pace)` : '';
        note = `The 50-day is closing in on the 200-day from above${eta}.`;
    } else if (event === 'golden_cross') {
        header = m.crossedUp
            ? `✨ <b>${name}: GOLDEN CROSS — recovered</b>`
            : `✅ <b>${name}: back above the 200-day</b>`;
        note = 'The 50-day moving average is <b>above</b> the 200-day again — the death cross has cleared.';
    }

    return [header, '', ...stats, '', note, '', `<i>As of close ${m.date} · source: Yahoo Finance</i>`].join('\n');
};

const deathcross = async (myTimer, context) => {
    const token = process.env.DEATHCROSS_TG_TOKEN;
    const chatId = process.env.DEATHCROSS_TG_CHAT_ID;
    if (!token || !chatId) {
        throw new Error('DEATHCROSS_TG_TOKEN and DEATHCROSS_TG_CHAT_ID must be set to send alerts');
    }

    const series = await fetchDailyCloses();
    const m = analyze(series);
    context.log(
        `deathcross: ${SYMBOL} close=${m.close.toFixed(2)} sma50=${m.sma50.toFixed(2)} sma200=${m.sma200.toFixed(2)} ` +
        `gap=${m.gap.toFixed(2)} (${m.gapPct.toFixed(2)}%) regime=${m.regime} ` +
        `daysToCross=${m.daysToCross === null ? 'n/a' : m.daysToCross.toFixed(1)}`
    );

    // A single durable row per symbol remembers the regime we last acted on, so
    // alerts fire on transitions instead of on every scheduled run.
    const partitionKey = SYMBOL.replace(/[^A-Za-z0-9]/g, '') || 'INDEX';
    const prev = await getLastRow(TABLE, partitionKey);
    const prevState = prev ? prev.State : null;

    const event = decideEvent(prevState, m.regime);

    if (event) {
        const message = buildMessage(event, m);
        // Send before persisting: if Telegram fails we throw here, leaving the
        // stored state untouched so the next run re-detects and retries.
        const tg = await sendMessage(token, chatId, message, { parseMode: 'HTML', disableWebPagePreview: true });
        context.log(`deathcross: sent '${event}' alert (message_id=${tg.result.message_id})`);
    } else {
        context.log(`deathcross: no transition (prev=${prevState ?? 'none'}, now=${m.regime}); no alert`);
    }

    await storeRow(TABLE, partitionKey, 'current', {
        State: m.regime,
        Close: m.close,
        Sma50: m.sma50,
        Sma200: m.sma200,
        Gap: m.gap,
        GapPct: m.gapPct,
        AsOf: m.date,
        UpdatedAt: new Date().toISOString(),
    });
};

// Once per weekday at 22:30 UTC — comfortably after the 20:00/21:00 UTC US
// market close (EDT/EST), by which point Yahoo's daily candle is finalized.
app.timer('deathcross', {
    schedule: '0 30 22 * * 1-5',
    handler: deathcross,
});

module.exports = { smaAt, analyze, decideEvent, buildMessage };
