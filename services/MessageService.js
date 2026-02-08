const activeChatManager = require("../utils/activeChatManager.js");
const llmSummaryManager = require("../utils/llmSummaryManager.js");
const statsHandler = require("../utils/statsHandler.js");
const devLogHandler = require("../utils/devLogHandler.js");

class MessageService {
    /**
     * Handle orchestration for every message received
     * @param {import('discord.js').Message} message 
     */
    async handleMessage(message) {
        // Debug: Log all messages to help troubleshoot collection issues
        const isWebhook = message.webhookId ? '🔗 [WEBHOOK]' : '👤 [USER]';
        const isBot = message.author.bot ? '🤖 [BOT]' : '✓';
        console.log(`[MessageCreate] ${isWebhook} ${isBot} @${message.author.username} in #${message.channel.name}: "${message.content.substring(0, 60)}"`);

        if (message.author.bot && !message.webhookId) {
            console.log(`[MessageCreate] Skipping bot message`);
            return;
        }

        // 1. Process Monitoring & Management
        await this.processMonitoring(message);

        // 2. Handle Dev Logs
        const isDevLog = await devLogHandler.handleDevLog(message);
        if (isDevLog) return;

        // 3. Handle Legacy Commands (& prefix)
        await this.handleLegacyCommand(message);
    }

    /**
     * Handle active chat monitoring and statistics
     * @param {import('discord.js').Message} message 
     */
    async processMonitoring(message) {
        // Active Chat Management
        activeChatManager.handleMessage(message).catch(err => console.error("ActiveChat Error:", err));

        // Trigger LLM Summary Check if hot channel detected
        try {
            await llmSummaryManager.handleHotChannel(message.channel, message.client);
        } catch (err) {
            console.error("LLMSummary Error:", err);
        }

        // Daily Statistics tracking
        try {
            statsHandler.trackMessageStats(message);
        } catch(err) {
            console.error("Stats Error:", err);
        }
    }

    /**
     * Handle legacy prefix-based commands (&)
     * @param {import('discord.js').Message} message 
     */
    async handleLegacyCommand(message) {
        if (!message.content.startsWith("&")) return;

        // Admin-only check for legacy commands
        if (!message.member.permissions.has("Administrator")) {
            return message.reply("❌ 需要管理員權限。");
        }

        const args = message.content.slice(1).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();
        const command = message.client.commands.get(commandName);

        if (!command) {
            return message.reply(`⚠️ 找不到指令：**${commandName}**`);
        }

        try {
            await command.execute(message, args);
        } catch (error) {
            console.error(error);
            message.reply("執行指令錯誤！");
        }
    }
}

module.exports = new MessageService();
