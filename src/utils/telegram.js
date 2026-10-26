const { Telegraf } = require('telegraf');

const sendMessage = async (token, chatId, message, options = {}) => {
    try {
        const bot = new Telegraf(token);

        const sendOptions = {
            parse_mode: options.parseMode || 'HTML',
            disable_web_page_preview: options.disableWebPagePreview || false,
            disable_notification: options.disableNotification || false,
            ...options
        };

        const result = await bot.telegram.callApi('sendMessage', {
            chat_id: chatId,
            text: message,
            ...sendOptions
        }, { signal: AbortSignal.timeout(15000) });
        return { ok: true, result };
    } catch (error) {
        throw new Error(`Failed to send Telegram message: ${error.message}`);
    }
};

module.exports = {
    sendMessage
};
