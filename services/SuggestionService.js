const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder
} = require('discord.js');
const config = require('../config/config.js');

const SUGGESTION_CHANNEL_ID = config.CHANNELS.SUGGESTION;

class SuggestionService {
    /**
     * Show the suggestion modal
     * @param {import('discord.js').ButtonInteraction} interaction 
     */
    async handleOpenModal(interaction) {
        const modal = new ModalBuilder()
            .setCustomId('submit_suggestion')
            .setTitle('📝 提供您的寶貴建議');

        const titleInput = new TextInputBuilder()
            .setCustomId('suggestion_title')
            .setLabel("建議主題")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("例如：希望新增更多語音頻道")
            .setRequired(true);

        const contentInput = new TextInputBuilder()
            .setCustomId('suggestion_content')
            .setLabel("詳細內容")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("請詳細描述您的想法...")
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(titleInput);
        const secondActionRow = new ActionRowBuilder().addComponents(contentInput);

        modal.addComponents(firstActionRow, secondActionRow);
        
        await interaction.showModal(modal);
    }

    /**
     * Handle suggestion form submission
     * @param {import('discord.js').ModalSubmitInteraction} interaction 
     */
    async handleSubmit(interaction) {
        const title = interaction.fields.getTextInputValue('suggestion_title');
        const content = interaction.fields.getTextInputValue('suggestion_content');

        try {
            const targetThread = await interaction.guild.channels.fetch(SUGGESTION_CHANNEL_ID);

            if (!targetThread) {
                return interaction.reply({ content: "❌ 設定錯誤：找不到指定的討論串，請確認 ID 是否正確。", ephemeral: true });
            }

            if (!targetThread.isThread()) {
                return interaction.reply({ content: "❌ 設定錯誤：指定的 ID 不是一個討論串 (Thread)。", ephemeral: true });
            }

            if (targetThread.archived) {
                await targetThread.setArchived(false);
            }

            const embed = new EmbedBuilder()
                .setTitle(`${title}`)
                .setDescription(content)
                .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
                .setColor(0xFFA500)
                .addFields({ name: '\n👤 建議者', value: interaction.user.toString(), inline: true })
                .setTimestamp();

            await targetThread.send({ embeds: [embed] });

            await interaction.reply({ content: "✅ 您的建議已送出至討論區！", ephemeral: true });

        } catch (error) {
            console.error("發送建議至討論串失敗：", error);
            
            let errorMsg = "❌ 發送失敗，請聯繫管理員。";
            if (error.code === 10003) errorMsg = "❌ 找不到該討論串 (Unknown Channel)，ID 可能錯了。";
            if (error.code === 50001) errorMsg = "❌ 機器人沒有權限在該討論串發言。";

            if (!interaction.replied) {
                await interaction.reply({ content: errorMsg, ephemeral: true });
            }
        }
    }
}

module.exports = new SuggestionService();
