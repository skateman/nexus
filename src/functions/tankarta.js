const { app } = require('@azure/functions');
const puppeteer = require('puppeteer-core');
const { storeFile, getLastRow, storeRow } = require('../utils/storage');

const DISCOUNT = process.env.ORLEN_DISCOUNT ? parseFloat(process.env.ORLEN_DISCOUNT) : 0;
const TOKEN = process.env.BROWSERLESS_TOKEN;
const DAILY_CHECK_PARTITION = 'daily-check';
const DAILY_CHECK_ROW = 'latest';

const scrape = async () => {
    const browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-ams.browserless.io/stealth?token=${TOKEN}&proxy=residential&proxyCountry=cz&proxySticky=true&proxyLocaleMatch=1`,
    });

    try {
        const page = await browser.newPage();

        // Visit the page and wait for the login form to show up
        await page.goto('https://business.tankarta.cz');
        await page.waitForSelector('#login');

        // Fill in the login form and submit
        await page.locator('#login').fill(process.env.ORLEN_USERNAME);
        await page.locator('#pwd').fill(process.env.ORLEN_PASSWORD);
        await page.locator('#submit').click();

        // Wait for the price table to load
        await page.waitForSelector('.box[data-widget="Price"] .box__list tbody tr');

        // Extract the price for "Efecta 95" from the price table
        const price = await page.evaluate(() => {
            const rows = document.querySelectorAll('.box[data-widget="Price"] .box__list tbody tr');
            const price = Array.from(rows).find((row) =>
                row.querySelectorAll('td')[0]?.textContent.trim() === 'Efecta 95'
            )?.querySelectorAll('td')[1]?.textContent.replace(',', '.');
            return price ? parseFloat(price) : null;
        });

        // Extract the remaining credit
        const credit = await page.evaluate(() => {
            const element = document.querySelector('.box[data-widget="Prepaid"] .box__content p');
            return element ? element.textContent.replace(/\s/g, '').replace(',', '.') : null;
        });

        if (!Number.isFinite(price)) {
            throw new Error('Could not extract Efecta 95 price');
        }
        if (credit === null) {
            throw new Error('Could not extract remaining credit');
        }

        const finalPrice = (price - DISCOUNT).toFixed(2);

        return { price: parseFloat(finalPrice), credit };
    } finally {
        await browser.close();
    }
};

const tankarta = async (myTimer, context) => {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const [lastPriceRow, lastCheckRow] = await Promise.all([
        getLastRow('tankarta', 'price'),
        getLastRow('tankarta', DAILY_CHECK_PARTITION, false),
    ]);

    // Later timer slots are retries only; skip after the first successful daily run.
    if (lastCheckRow?.CheckedDate === today) {
        context.log(`Tankarta already checked today: price=${lastCheckRow.Price}, credit=${lastCheckRow.Credit}. Skipping scraping.`);
        return;
    }

    // Scrape the data
    const { price, credit } = await scrape();

    const lastStoredPrice = lastPriceRow ? lastPriceRow.Price : null;
    const priceChanged = lastStoredPrice === null || lastStoredPrice !== price;
    
    // Keep price history change-only.
    if (priceChanged) {
        await storeRow('tankarta', 'price', today, { Price: price });
        context.log(`Tankarta price updated: ${price}`);
    } else {
        context.log(`Tankarta price unchanged: ${price}`);
    }

    // Refresh current values for iOS Shortcuts after every successful daily scrape.
    const tomorrow = new Date(new Date(today).getTime() + 24 * 60 * 60 * 1000); // 24 hours from today
    await storeFile('nexus-results', 'tankarta-price.txt', price.toString(), 'text/plain', tomorrow);
    await storeFile('nexus-results', 'tankarta-credit.txt', credit, 'text/plain', tomorrow);

    // Write this last so a failed storage update is retried by the next timer slot.
    await storeRow('tankarta', DAILY_CHECK_PARTITION, DAILY_CHECK_ROW, {
        CheckedDate: today,
        Price: price,
        Credit: credit,
    });

    context.log(`Tankarta credit updated: ${credit}`);
}

// Runs once at 3:12:37, 5:12:37, 7:12:37, and 9:12:37 UTC
app.timer('tankarta', {
    schedule: '37 12 3,5,7,9 * * *',
    handler: tankarta
});
