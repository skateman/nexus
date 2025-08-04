const { app } = require('@azure/functions');
const puppeteer = require('puppeteer-core');
const { storeFile } = require('../utils/storage');

const DISCOUNT = process.env.ORLEN_DISCOUNT ? parseFloat(process.env.ORLEN_DISCOUNT) : 0;
const TOKEN = process.env.BROWSERLESS_TOKEN;

const tankarta = async (myTimer, context) => {
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
    
    // Store data to storage account with expiry date set to tomorrow
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    await storeFile('nexus-results', 'tankarta-price.txt', finalPrice, 'text/plain', tomorrow);
    await storeFile('nexus-results', 'tankarta-credit.txt', credit, 'text/plain', tomorrow);

    context.log(`Tankarta price updated: ${finalPrice}`);
    context.log(`Tankarta credit updated: ${credit}`);
}

// Runs once at 3:12:37, 5:12:37, 7:12:37, and 9:12:37 UTC
app.timer('tankarta', {
    schedule: '37 12 3,5,7,9 * * *',
    handler: tankarta
});
