const { app } = require('@azure/functions');
const puppeteer = require('puppeteer-core');
const { sendMessage } = require('../utils/telegram');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const DASHBOARD_URL = 'https://sluzby.mujkaktus.cz/moje-sluzby';

// Send a Telegram alert only when the credit can't cover the next data renewal
// AND there are still enough days to act. Inside that window the alert is
// "too late" so we stay quiet.
const ALERT_MIN_DAYS_BEFORE_RENEWAL = 3;

const scrape = async () => {
    const browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${BROWSERLESS_TOKEN}`,
    });

    try {
        const page = await browser.newPage();

        // Hitting the dashboard redirects to the SSO login form
        await page.goto(DASHBOARD_URL);
        await page.waitForSelector('input[type="password"]');
        // The login form's xstate machine takes a moment to attach its
        // event handlers after the inputs render. Without this settle,
        // keystrokes are typed before the framework is listening and
        // the submit handler later sees an empty internal state.
        await new Promise((r) => setTimeout(r, 1500));

        // The login form is built with custom web components managed by an
        // xstate machine. Two quirks that fight typical puppeteer recipes:
        //   - the username input has no `type` attribute, so `input[type="text"]`
        //     does NOT match it; we select by class + exclusion instead.
        //   - the framework's submit handler only fires on Enter, not on a
        //     button click. We type Enter on the password field instead.
        //   - `locator.fill()` is too strict for these inputs (waits for an
        //     editability hint that never arrives); we use page.focus() +
        //     keyboard.type() which sends real key events at CDP level.
        await page.focus('input.tm-input__input:not([type="password"])');
        await page.keyboard.type(process.env.GARAGEKAKTUS_USERNAME, { delay: 30 });
        await page.focus('input[type="password"]');
        await page.keyboard.type(process.env.GARAGEKAKTUS_PASSWORD, { delay: 30 });
        await page.keyboard.press('Enter');

        // The OAuth callback chain navigates the page several times before
        // the dashboard renders, and the dashboard's "Celkem:" + "se obnoví"
        // panels are themselves lazy-loaded.  Puppeteer's waitForFunction
        // binds to a single frame execution context that gets destroyed by
        // each navigation, so it isn't reliable here.  Poll from Node side
        // instead, swallowing the transient "execution context destroyed"
        // errors that happen mid-navigation.
        const deadline = Date.now() + 60000;
        let ready = false;
        while (Date.now() < deadline && !ready) {
            await new Promise((r) => setTimeout(r, 1000));
            ready = await page.evaluate(() => {
                if (!/sluzby\.mujkaktus\.cz\/moje-sluzby/.test(location.href)) return false;
                const text = document.body.innerText;
                return /Celkem:\s*[\d\s.,]+\s*Kč/.test(text)
                    && /se obnoví\s+\d{1,2}\.\d{1,2}\.\d{4}/.test(text);
            }).catch(() => false);
        }
        if (!ready) throw new Error('Dashboard did not render credit + renewal panels within 60s');

        return await page.evaluate(() => {
            const text = document.body.innerText;
            const num = (raw) => parseFloat(raw.replace(/[\s\u00A0]/g, '').replace(',', '.'));

            const creditMatch = text.match(/Celkem:\s*([\d\s\u00A0.,]+?)\s*Kč/);
            const renewalDateMatch = text.match(/se obnoví\s+(\d{1,2}\.\d{1,2}\.\d{4})/);
            const renewalCostMatch = text.match(/se obnoví[\s\S]{0,200}?za\s+([\d\s\u00A0.,]+?)\s*Kč/);

            return {
                credit: creditMatch ? num(creditMatch[1]) : null,
                renewalDateText: renewalDateMatch ? renewalDateMatch[1] : null,
                renewalCost: renewalCostMatch ? num(renewalCostMatch[1]) : null,
            };
        });
    } finally {
        await browser.close();
    }
};

// Days from "today in Europe/Prague" until the given Czech-format date
// "D.M.YYYY" (interpreted as Prague-local midnight). Negative if past.
const daysUntilPragueDate = (czechDate, now = new Date()) => {
    const m = czechDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) throw new Error(`Could not parse Czech date: "${czechDate}"`);
    const [, dd, mm, yyyy] = m;
    const target = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd));

    const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Prague',
        year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const [ty, tm, td] = fmt.format(now).split('-').map(Number);
    const today = Date.UTC(ty, tm - 1, td);

    return Math.round((target - today) / (24 * 60 * 60 * 1000));
};

const buildAlertMessage = ({ credit, renewalDateText, daysUntilRenewal }) => [
    '⚠️ <b>Garage Kaktus: low credit</b>',
    '',
    `💰 Current credit: <b>${credit} Kč</b>`,
    `🔄 Data renews on <b>${renewalDateText}</b> (in ${daysUntilRenewal} ${daysUntilRenewal === 1 ? 'day' : 'days'})`,
].join('\n');

const garagekaktus = async (myTimer, context) => {
    const { credit, renewalDateText, renewalCost } = await scrape();
    if (credit === null) throw new Error('Could not extract credit from dashboard');

    const daysUntilRenewal = renewalDateText ? daysUntilPragueDate(renewalDateText) : null;
    context.log(`garagekaktus: credit=${credit} Kč, renewal=${renewalDateText} (in ${daysUntilRenewal} days), renewalCost=${renewalCost} Kč`);

    if (renewalCost === null || renewalDateText === null) {
        context.log('garagekaktus: no auto-renewing package detected; skipping alert');
        return;
    }
    if (credit >= renewalCost) {
        context.log(`garagekaktus: credit (${credit}) >= renewal cost (${renewalCost}); no alert`);
        return;
    }
    if (daysUntilRenewal < ALERT_MIN_DAYS_BEFORE_RENEWAL) {
        context.log(`garagekaktus: only ${daysUntilRenewal} day(s) until renewal — too late to act, skipping alert`);
        return;
    }

    const token = process.env.GARAGEKAKTUS_TG_TOKEN;
    const chatId = process.env.GARAGEKAKTUS_TG_CHAT_ID;
    if (!token || !chatId) {
        throw new Error('GARAGEKAKTUS_TG_TOKEN and GARAGEKAKTUS_TG_CHAT_ID must be set to send alerts');
    }

    const message = buildAlertMessage({ credit, renewalDateText, daysUntilRenewal });
    const tg = await sendMessage(token, chatId, message, { parseMode: 'HTML', disableWebPagePreview: true });
    context.log(`garagekaktus: Telegram alert sent (message_id=${tg.result.message_id})`);
};

// Once a day at 08:17:47 UTC
app.timer('garagekaktus', {
    schedule: '47 17 8 * * *',
    handler: garagekaktus,
});

module.exports = { daysUntilPragueDate, buildAlertMessage };
