const llmSummaryManager = require('../utils/llmSummaryManager.js');

class SummaryService {
    /**
     * Handle approval of a summary
     * @param {import('discord.js').ButtonInteraction} interaction 
     * @param {import('discord.js').Client} client 
     */
    async handleApprove(interaction, client) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const summaryId = interaction.customId.replace('summary_approve_', '');
            const summary = llmSummaryManager.getPendingSummary(summaryId);

            if (!summary) {
                return await interaction.editReply({
                    content: '❌ 找不到該摘要或已過期'
                });
            }

            await interaction.editReply({
                content: '⏳ 正在生成完整摘要...'
            });

            await llmSummaryManager.generateFullSummary(summaryId, client);

            await interaction.editReply({
                content: '✅ 摘要已生成並發佈到摘要頻道'
            });
        } catch (error) {
            console.error('[SummaryApprove] Error:', error);
            await interaction.editReply({
                content: `❌ 生成摘要時出錯：${error.message}`
            });
        }
    }

    /**
     * Handle rejection of a summary
     * @param {import('discord.js').ButtonInteraction} interaction 
     */
    async handleReject(interaction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const summaryId = interaction.customId.replace('summary_reject_', '');
            await llmSummaryManager.rejectSummary(summaryId);

            await interaction.editReply({
                content: '✅ 已忽略此摘要'
            });
        } catch (error) {
            console.error('[SummaryReject] Error:', error);
            await interaction.editReply({
                content: `❌ 操作時出錯：${error.message}`
            });
        }
    }
}

module.exports = new SummaryService();
