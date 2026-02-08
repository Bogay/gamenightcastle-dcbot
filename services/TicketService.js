const {
    ChannelType,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    AttachmentBuilder
} = require('discord.js');
const config = require('../config/config.js');

const TICKET_LOG_CHANNEL_ID = config.CHANNELS.TICKET_LOG;

class TicketService {
    /**
     * Handle opening a new ticket channel
     * @param {import('discord.js').ButtonInteraction} interaction 
     * @param {import('discord.js').Client} client 
     */
    async handleOpenTicket(interaction, client) {
        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const user = interaction.user;
        const category = interaction.channel.parent;

        // Check for existing ticket
        const existingChannel = guild.channels.cache.find(c => c.name === `住客申請-${user.username.toLowerCase()}`);
        if (existingChannel) {
            return interaction.editReply({ content: `❌ 您已經有一個進行中的申請單：${existingChannel}` });
        }

        try {
            const ticketChannel = await guild.channels.create({
                name: `住客申請-${user.username}`,
                type: ChannelType.GuildText,
                parent: category ? category.id : null,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ],
            });

            const closeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_ticket').setLabel('關閉申請單').setStyle(ButtonStyle.Danger).setEmoji('🔒')
            );

            // 1. Create Rules Embed
            const rulesEmbed = new EmbedBuilder()
                .setTitle('📜 樓層規範')
                .setColor(0xFF0000)
                .setDescription(
                    '1️⃣ 每位開發者皆可申請一層樓，並擁有該樓層的自主管理權\n\n' +
                    '2️⃣ 樓層包含：一間文字頻道 + 一間語音頻道(可選)\n\n' +
                    '3️⃣ 若為團隊申請樓層，請提交所需管理權限的人員名單\n\n' +
                    '4️⃣ 樓層命名請勿有任何髒話、辱罵、色情等不雅字眼\n\n' +
                    '5️⃣ 若為18禁的樓層，名稱前綴記得註記18禁符號🔞\n\n' +
                    '6️⃣ 18禁內容嚴禁有任何未成年、圖像人物必須符合成熟特徵\n\n' +
                    '7️⃣ 頻道分享內容不限，但請盡量以遊戲相關的討論為主\n\n' +
                    '8️⃣ 樓層每三個月會針對活躍度進行評估，活躍度過低的頻道將會視情況隱藏，請樓層負責人主動向管理員提出申訴\n\n' +
                    '9️⃣ 嚴禁違反社群規範，詳情請見：https://discord.com/channels/859390147110633512/859390147656679457/1257649090821488703\n\n' +
                    '※以上規範，夜城擁有最終解釋權\n' +
                    '-# 更新日期：2025/12/11'
                );

            // 2. Create Application Form Embed
            const applyEmbed = new EmbedBuilder()
                .setTitle('📝 樓層申請格式')
                .setColor(0x00FF00)
                .setDescription(
                    '**樓層名稱：**\n' +
                    '\n' +
                    '**文字頻道名稱：**\n' +
                    '\n' +
                    '**樓層用途：**\n' +
                    '(開發進度分享、遊戲知識分享、日常分享...等等)\n' +
                    '\n' +
                    '**是否需要語音頻道：**\n' +
                    '(需要的話請填頻道名稱)\n' +
                    '\n' +
                    '**是否包含🔞資訊：**\n' +
                    '\n' +
                    '**是否希望機器人能推播提醒進度的通知：**\n' +
                    '(每個月一次)\n' +
                    '\n' +
                    '**額外提醒時間：(每周/每兩周/其他)：**\n' +
                    '\n' +
                    '**樓層管理員：**'
                );

            await ticketChannel.send({
                content: `${user} 冒險者您好！歡迎使用本服務，請詳閱規範後填寫申請表。`,
                embeds: [rulesEmbed, applyEmbed],
                components: [closeRow]
            });

            await interaction.editReply({ content: `✅ 請前往填寫入住申請單：${ticketChannel}` });

        } catch (error) {
            console.error(error);
            await interaction.editReply({ content: "⚠️ 發生不可預期異常，請聯繫管理員。" });
        }
    }

    /**
     * Handle closing a ticket channel
     * @param {import('discord.js').ButtonInteraction} interaction 
     */
    async handleCloseTicket(interaction) {
        if (!interaction.channel.name.startsWith('住客申請-')) {
            return interaction.reply({ content: "這不是一個有效的 Ticket 頻道。", ephemeral: true });
        }
        await interaction.reply("🔒 申請單將在 5 秒後關閉...");

        try {
            const messages = await interaction.channel.messages.fetch({ limit: 100 });
            
            const transcript = messages.reverse().map(m => {
                const time = m.createdAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                const content = m.content || (m.embeds.length ? '[嵌入內容]' : '[圖片/檔案]');
                const attachments = m.attachments.size > 0 ? ` [附件: ${m.attachments.map(a => a.url).join(', ')}]` : '';
                return `[${time}] ${m.author.tag}: ${content}${attachments}`;
            }).join('\n');

            const logChannel = interaction.guild.channels.cache.get(TICKET_LOG_CHANNEL_ID);
            
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle(`🔒 申請單已關閉：${interaction.channel.name}`)
                    .setColor(0xFF0000)
                    .addFields(
                        { name: '關閉者', value: interaction.user.tag, inline: true },
                        { name: '頻道名稱', value: interaction.channel.name, inline: true },
                        { name: '訊息數量', value: `${messages.size} 則`, inline: true }
                    )
                    .setTimestamp();

                if (transcript.length < 1900) {
                    await logChannel.send({ 
                        embeds: [embed],
                        content: `**📝 對話紀錄：**\n\
\
${transcript}\n\
\
` 
                    });
                } else {
                    const buffer = Buffer.from(transcript, 'utf-utf-8');
                    const attachment = new AttachmentBuilder(buffer, { name: `transcript-${interaction.channel.name}.txt` });
                    
                    await logChannel.send({
                        embeds: [embed],
                        content: `**📝 對話紀錄過長，已轉為檔案附件：**`,
                        files: [attachment] 
                    });
                }
            } else {
                console.warn(`⚠️ 找不到 Log 頻道 (${TICKET_LOG_CHANNEL_ID})，無法備份紀錄。`);
            }

        } catch (err) {
            console.error("備份紀錄失敗:", err);
        }

        setTimeout(() => {
            interaction.channel.delete().catch(err => console.error("關閉頻道失敗:", err));
        }, 5000);
    }
}

module.exports = new TicketService();
