const { Events } = require('discord.js');
const TicketService = require('../services/TicketService');
const SuggestionService = require('../services/SuggestionService');
const SummaryService = require('../services/SummaryService');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction, client) {

        // ====================================================
        // 🔘 區域 1：按鈕互動處理 (Button Interactions)
        // ====================================================
        if (interaction.isButton()) {
            const { customId } = interaction;

            // LLM Summary Approval
            if (customId.startsWith('summary_approve_')) {
                return await SummaryService.handleApprove(interaction, client);
            }
            if (customId.startsWith('summary_reject_')) {
                return await SummaryService.handleReject(interaction);
            }

            // Ticket System
            if (customId === 'open_ticket') {
                return await TicketService.handleOpenTicket(interaction, client);
            }
            if (customId === 'close_ticket') {
                return await TicketService.handleCloseTicket(interaction);
            }

            // Suggestion System (Open Modal)
            if (customId === 'open_suggestion_modal') {
                return await SuggestionService.handleOpenModal(interaction);
            }
        }

        // ====================================================
        // 📝 區域 2：表單提交處理 (Modal Submits)
        // ====================================================
        if (interaction.isModalSubmit()) {
            const { customId } = interaction;

            // Suggestion System (Submit Form)
            if (customId === 'submit_suggestion') {
                return await SuggestionService.handleSubmit(interaction);
            }
        }
    },
};