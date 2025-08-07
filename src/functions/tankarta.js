const { app } = require('@azure/functions');
const puppeteer = require('puppeteer-core');
const { storeFile, getLastRow, storeRow } = require('../utils/storage');

const DISCOUNT = process.env.ORLEN_DISCOUNT ? parseFloat(process.env.ORLEN_DISCOUNT) : 0;
const TOKEN = process.env.BROWSERLESS_TOKEN;

const scrape = async () => {
    const browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${TOKEN}`,
    });

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

    await browser.close();

    const finalPrice = (price - DISCOUNT).toFixed(2);

    return { price: parseFloat(finalPrice), credit };
};

const tankarta = async (myTimer, context) => {
    // Get the last stored row
    const lastRow = await getLastRow('tankarta', 'price');
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

    // Skip scraping if we already stored a price today
    if (lastRow && lastRow.rowKey === today) {
        context.log(`Price already recorded today: ${lastRow.Price}. Skipping scraping.`);
        return;
    }

    // Scrape the data
    const { price, credit } = await scrape();

    const lastStoredPrice = lastRow ? lastRow.Price : null;
    
    // Early return if price hasn't changed
    if (lastStoredPrice !== null && lastStoredPrice === price) {
        context.log(`Price unchanged (${price}). No updates made.`);
        return;
    }

    // Store historical data and update blob storage
    await storeRow('tankarta', 'price', today, { Price: price });

    // Also update blob storage for iOS Shortcuts (current price)
    const tomorrow = new Date(new Date(today).getTime() + 24 * 60 * 60 * 1000); // 24 hours from today
    await storeFile('nexus-results', 'tankarta-price.txt', price.toString(), 'text/plain', tomorrow);
    await storeFile('nexus-results', 'tankarta-credit.txt', credit, 'text/plain', tomorrow);

    context.log(`Tankarta price updated: ${price}`);
    context.log(`Tankarta credit updated: ${credit}`);
}

// Runs once at 3:12:37, 5:12:37, 7:12:37, and 9:12:37 UTC
app.timer('tankarta', {
    schedule: '37 12 3,5,7,9 * * *',
    handler: tankarta
});
