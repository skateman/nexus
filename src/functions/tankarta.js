const { app } = require('@azure/functions');
const puppeteer = require('puppeteer');

async function scrapeNumber(url) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    await page.goto(url);
    
    const text = await page.evaluate(() => document.body.textContent);
    const number = parseFloat(text.match(/\d+\.?\d*/)[0]);
    
    await browser.close();
    return number;
}

async function httpTrigger(request, context) {
    const url = request.query.get('url');
    const number = await scrapeNumber(url);
    
    return {
        status: 200,
        body: JSON.stringify({ number })
    };
}

app.http('scrapeNumber', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: httpTrigger
});
