const { app } = require('@azure/functions');
const { sendMessage } = require('../utils/telegram');
const { storeFile, getFile } = require('../utils/storage');
const pdfParse = require('pdf-parse');
const { JSDOM } = require('jsdom');

const TOKEN = process.env.DOBIJECKA_TG_TOKEN;
const CHAT_ID = process.env.DOBIJECKA_TG_CHAT_ID;

// Helper function to get cookies from homepage
const getCookies = async () => {
    try {
        const response = await fetch('https://www.mujkaktus.cz/');
        const cookieHeader = response.headers.get('set-cookie');
        if (cookieHeader) {
            // Simple cookie parsing - extract cookie values
            return cookieHeader.split(',').reduce((cookies, cookie) => {
                const [nameValue] = cookie.trim().split(';');
                const [name, value] = nameValue.split('=');
                if (name && value) {
                    cookies[name.trim()] = value.trim();
                }
                return cookies;
            }, {});
        }
        return {};
    } catch (error) {
        return {};
    }
};

const isToday = (pdfUrl) => {
    if (!pdfUrl) return false;

    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = today.getFullYear();
    const todayPattern = `${day}${month}${year}`;

    // Check if PDF filename contains today's date
    const pdfDatePattern = /OP-Odmena-za-dobiti-FB_(\d{8})\.pdf/;
    const match = pdfUrl.match(pdfDatePattern);

    return match && match[1] === todayPattern;
};

// Helper function to extract text starting with "období od" from PDF
const extractTimeIntervalFromPdf = async (pdfUrl, headers, context) => {
    try {
        context.log('Downloading PDF for text extraction...');

        const pdfResponse = await fetch(pdfUrl, { headers });
        if (!pdfResponse.ok) {
            throw new Error(`Failed to download PDF: ${pdfResponse.status}`);
        }

        const pdfBuffer = await pdfResponse.arrayBuffer();
        const pdfData = await pdfParse(Buffer.from(pdfBuffer));

        context.log('PDF text length:', pdfData.text.length);

        // Look for text that contains "období od" (period from) - try different approaches
        const text = pdfData.text;

        // First try: look for "období od" in the original text with line breaks
        const lines = text.split('\n');
        let foundLine = '';
        let startIndex = -1;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes('období od')) {
                foundLine = lines[i].trim();
                startIndex = i;
                break;
            }
        }

        if (foundLine) {
            // If we found the start, try to get the complete sentence by looking at subsequent lines
            let completeText = foundLine;
            for (let i = startIndex + 1; i < Math.min(startIndex + 3, lines.length); i++) {
                const nextLine = lines[i].trim();
                if (nextLine && !nextLine.match(/^\d+\./)) { // Skip numbered items
                    completeText += ' ' + nextLine;
                    // Stop if we find what looks like a complete sentence with time
                    if (nextLine.includes('hod') || nextLine.match(/\d{1,2}:\d{2}/)) {
                        break;
                    }
                }
            }

            context.log('Found time interval text:', completeText);

            // Clean up the text - remove redundant prefixes
            return completeText.replace(/^(využít v\s*)?období\s+(od\s+)/i, '$2');
        }

        context.log('No "období od" text found in PDF');
        return null;

    } catch (error) {
        console.error('Error extracting text from PDF:', error.message);
        return null;
    }
};

const dobijecka = async (myTimer, context) => {
    try {
        // Get cookies first for better session handling
        const cookies = await getCookies();
        const cookieString = Object.entries(cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join('; ');

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
        if (cookieString) {
            headers['Cookie'] = cookieString;
        }

        const response = await fetch('https://www.mujkaktus.cz/chces-pridat', { headers });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const htmlContent = await response.text();

        // Parse HTML using jsdom
        const dom = new JSDOM(htmlContent);
        const document = dom.window.document;

        // Find PDF link
        const pdfLinkElement = document.querySelector('a[href*="OP-Odmena-za-dobiti-FB"]');

        if (!pdfLinkElement || !pdfLinkElement.href) {
            throw new Error('No PDF link found - dobíječka might not be active');
        }

        const pdfUrl = pdfLinkElement.href;
        context.log('Found PDF link:', pdfUrl);

        // Check if PDF is for today
        if (!isToday(pdfUrl)) {
            context.log('PDF is not for today - skipping');
            return;
        }
        context.log('PDF is for today - extracting time interval from PDF...');

        // Check if there has been no telegram message sent for today
        try {
            const today = new Date().toISOString().split('T')[0];
            const lastPostedFile = await getFile('nexus-results', 'dobijecka-last.txt');

            if (lastPostedFile && lastPostedFile.content.trim() === today) {
                context.log('Dobíječka message already posted today - skipping');
                return;
            }
        } catch (error) {
            context.log('Could not check last posted date:', error.message);
        }

        // Extract time interval text from PDF
        const timeIntervalText = await extractTimeIntervalFromPdf(pdfUrl, headers, context);

        if (!timeIntervalText) {
            throw new Error('No time interval text found in PDF starting with "období od"');
        }

        // Prepare result object
        const result = {
            pdfLink: pdfUrl,
            timeIntervalText: timeIntervalText,
            extractedAt: new Date().toISOString(),
            source: 'pdf'
        };

        context.log(`Successfully extracted time interval from PDF`);
        context.log(`- PDF Link: "${result.pdfLink}"`);
        context.log(`- Time Interval: "${result.timeIntervalText}"`);

        // Send Telegram notification
        // Format the Kaktus dobíječka message
        const message = `
            🎉 <b>Kaktus Dobíječka je aktivní!</b>

            📅 <b>Období:</b> ${result.timeIntervalText}

            🔗 <a href="https://www.mujkaktus.cz/chces-pridat">Zobrazit detaily</a>

            <i>Extrahováno: ${new Date(result.extractedAt).toLocaleString('cs-CZ')}</i>
        `.replace(/^\s+/gm, '').trim();

        const telegramResponse = await sendMessage(TOKEN, CHAT_ID, message, {
            parseMode: 'HTML',
            disableWebPagePreview: false
        });

        context.log(`Telegram message sent successfully: Message ID ${telegramResponse.result.message_id}`);

        // Mark that we've posted today
        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await storeFile('nexus-results', 'dobijecka-last.txt', today, 'text/plain', tomorrow);

    } catch (error) {
        console.error('Error in dobijecka function:', error.message);
        throw error;
    }
};

// Set up timer trigger - runs every 20 minutes between 12:00-16:00 UTC daily
app.timer('dobijecka', {
    schedule: '0 */20 12-16 * * *',
    handler: dobijecka
});