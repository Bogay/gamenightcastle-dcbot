// utils/llmSummaryManager.js
/**
 * LLM Summary Manager - Orchestrates the discussion summarization workflow
 * Detects gamedev discussions, performs relevance check, and generates summaries
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('crypto').randomUUID ? { v4: () => require('crypto').randomUUID() } : { v4: () => Math.random().toString(36).substr(2, 9) };
const config = require('../config/config.js');
const conversationCollector = require('./conversationCollector.js');
const llmService = require('./llmService.js');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const STATE_FILE_PATH = path.join(__dirname, '../data/llmSummaryState.json');

// Category color mapping
const CATEGORY_COLORS = {
    technics: 0x3498DB,  // Blue
    art: 0xE74C3C,       // Red
    design: 0x9B59B6,    // Purple
    news: 0xF39C12,      // Orange
    resource: 0x27AE60,  // Green
    other: 0x95A5A6      // Gray
};

// State in memory
let state = {
    pendingSummaries: {},
    rateLimits: {
        hourlyRequests: {},
        channelCooldowns: {}
    },
    summarizedTopicFingerprints: [],
    lastCleanup: 0
};

// Load state on startup
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
            const loaded = JSON.parse(raw);
            state = { ...state, ...loaded };
            if (!state.summarizedTopicFingerprints) state.summarizedTopicFingerprints = [];
            console.log('[LLMSummaryManager] State loaded');
        }
    } catch (error) {
        console.error('[LLMSummaryManager] Failed to load state:', error);
    }
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('[LLMSummaryManager] Failed to save state:', error);
    }
}

loadState();

// Clean up expired summaries every hour
// Use .unref() to allow process to exit even if timer is pending (good for tests)
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const llmConfig = config.LLM_SUMMARY || {};
    const timeout = llmConfig.timeouts?.adminApprovalTimeout || 24 * 60 * 60 * 1000;

    for (const [id, summary] of Object.entries(state.pendingSummaries)) {
        if (now - summary.createdAt > timeout) {
            delete state.pendingSummaries[id];
        }
    }

    // Clean up hourly rate limits
    for (const [hour, count] of Object.entries(state.rateLimits.hourlyRequests)) {
        if (parseInt(hour) < now - 60 * 60 * 1000) {
            delete state.rateLimits.hourlyRequests[hour];
        }
    }

    state.lastCleanup = now;
    saveState();
}, 60 * 60 * 1000);

// Allow process to exit even if this interval is pending
if (cleanupInterval.unref) {
    cleanupInterval.unref();
}

module.exports = {
    /**
     * 每日回顧掃描所有白名單頻道
     */
    async performDailyScan(client) {
        try {
            console.log(`\n[LLMSummaryManager] ========== STARTING DAILY RETROSPECTIVE SCAN ==========`);
            const llmConfig = config.LLM_SUMMARY || {};
            if (!llmConfig.enabled) return;

            const whitelist = llmConfig.channels.whitelist;
            const maturationMs = (llmConfig.filters.maturationDays || 3) * 24 * 60 * 60 * 1000;
            const scanDays = llmConfig.filters.scanLimitDays || 7;
            
            // Stabilize "now" to the start of the current hour for consistent windowing
            const now = new Date();
            now.setMinutes(0, 0, 0);
            const stableNow = now.getTime();
            const maturationPoint = stableNow - maturationMs;

            for (const channelId of whitelist) {
                const channel = client.channels.cache.get(channelId);
                if (!channel) continue;

                console.log(`[LLMSummaryManager] Scanning #${channel.name}...`);
                
                // 取得時間窗口內的歷史訊息
                const messages = await conversationCollector.collectMessagesInTimeWindow(channel, scanDays);
                if (messages.length < llmConfig.filters.minMessages) continue;

                // 第一階段：主題發現
                console.log(`[LLMSummaryManager] Discovering topics in #${channel.name} (${messages.length} messages)...`);
                const clusters = await llmService.discoverTopics(messages);
                
                for (const cluster of clusters) {
                    if (!cluster.isRelevant) continue;

                    // Map IDs back to message objects
                    const clusterMsgs = messages.filter(m => cluster.messageIds.includes(m.id));
                    
                    // 第二階段：成熟度檢查
                    // 核心部分：早於成熟時間點的訊息
                    const mainPart = clusterMsgs.filter(m => m.timestamp < maturationPoint);
                    
                    if (mainPart.length < llmConfig.filters.minMessages) {
                        console.log(`[LLMSummaryManager] Topic "${cluster.topic}" too young or small (main part: ${mainPart.length})`);
                        continue;
                    }

                    // 第三階段：去重複使用「錨點指紋」(Anchor Fingerprint)
                    // 使用討論簇中最早的 5 則訊息 ID 作為錨點
                    // 這確保即使後續討論進入成熟窗口，指紋依然穩定不變
                    const sortedClusterIds = [...cluster.messageIds].sort();
                    const anchorIds = sortedClusterIds.slice(0, 5);
                    const fingerprint = this._generateFingerprint(anchorIds);
                    
                    if (state.summarizedTopicFingerprints.includes(fingerprint)) {
                        console.log(`[LLMSummaryManager] Topic "${cluster.topic}" already summarized (anchor fingerprint match)`);
                        continue;
                    }

                    console.log(`[LLMSummaryManager] ✅ Topic "${cluster.topic}" ready for summary!`);

                    // 建立管理員審核項目
                    const summaryId = this._generateId();
                    const stats = conversationCollector.getStatistics(clusterMsgs);

                    state.pendingSummaries[summaryId] = {
                        id: summaryId,
                        channelId: channel.id,
                        channelName: channel.name,
                        topicName: cluster.topic,
                        createdAt: Date.now(),
                        messages: clusterMsgs,
                        stats: stats,
                        relevanceResult: {
                            isRelevant: true,
                            category: cluster.category,
                            reason: cluster.reason
                        },
                        status: 'pending_approval',
                        fingerprint: fingerprint
                    };
                    
                    await this._sendAdminNotification(summaryId, channel, client, state.pendingSummaries[summaryId].relevanceResult, stats, cluster.topic);
                }
            }
            
            saveState();
            console.log(`[LLMSummaryManager] ========== DAILY SCAN COMPLETE ==========\n`);
        } catch (error) {
            console.error('[LLMSummaryManager] Daily scan failed:', error);
        }
    },

    /**
     * Hook called when activeChatManager detects a hot channel
     * @param {Channel} channel - The active channel
     * @param {Client} client - Discord client
     * @returns {Promise<void>}
     */
    async handleHotChannel(channel, client) {
        try {
            if (!channel || !client) return;

            console.log(`\n[LLMSummaryManager] ========== HOT CHANNEL DETECTED ==========`);
            console.log(`[LLMSummaryManager] Channel: #${channel.name} (ID: ${channel.id})`);

            const llmConfig = config.LLM_SUMMARY || {};

            if (!llmConfig.enabled) {
                console.log(`[LLMSummaryManager] ❌ LLM Summary not enabled`);
                return;
            }

            console.log(`[LLMSummaryManager] ✅ LLM Summary enabled`);

            // Check if channel is whitelisted
            if (llmConfig.channels.whitelist.length > 0 &&
                !llmConfig.channels.whitelist.includes(channel.id)) {
                console.log(`[LLMSummaryManager] ❌ Channel not in whitelist`);
                return;
            }

            console.log(`[LLMSummaryManager] ✅ Channel whitelist check passed`);

            console.log(`[LLMSummaryManager] Processing hot channel: ${channel.name}`);

            // Collect messages
            const messages = await conversationCollector.collectMessages(
                channel,
                llmConfig.filters.lookbackWindow
            );

            console.log(`[LLMSummaryManager] Collected ${messages.length} valid messages, min required: ${llmConfig.filters.minMessages}`);

            if (messages.length < llmConfig.filters.minMessages) {
                console.log(`[LLMSummaryManager] ❌ Not enough messages (${messages.length}/${llmConfig.filters.minMessages})`);
                return;
            }

            console.log(`[LLMSummaryManager] ✅ Sufficient messages collected`);

            // Stage 1: Quick relevance check
            console.log(`[LLMSummaryManager] Starting relevance check...`);
            const relevanceResult = await llmService.quickRelevanceCheck(messages);

            console.log(`[LLMSummaryManager] Relevance Result:
  - isRelevant: ${relevanceResult.isRelevant}
  - category: ${relevanceResult.category}
  - reason: ${relevanceResult.reason}`);

            if (!relevanceResult.isRelevant) {
                console.log(`[LLMSummaryManager] ❌ Not relevant`);
                return;
            }

            console.log(`[LLMSummaryManager] ✅ Relevance check passed`);


            // Create summary entry
            const summaryId = this._generateId();
            const stats = conversationCollector.getStatistics(messages);

            console.log(`[LLMSummaryManager] Creating summary entry: ${summaryId}`);

            state.pendingSummaries[summaryId] = {
                id: summaryId,
                channelId: channel.id,
                channelName: channel.name,
                createdAt: Date.now(),
                messages: messages,
                stats: stats,
                relevanceResult: relevanceResult,
                status: 'pending_approval'
            };

            saveState();

            console.log(`[LLMSummaryManager] ✅ Summary entry created and saved`);
            console.log(`[LLMSummaryManager] Sending admin notification...`);

            // Send admin notification
            await this._sendAdminNotification(summaryId, channel, client, relevanceResult, stats);
            console.log(`[LLMSummaryManager] ========== HOT CHANNEL PROCESSING COMPLETE ==========\n`);
        } catch (error) {
            console.error('[LLMSummaryManager] Error in handleHotChannel:', error);
            console.log(`[LLMSummaryManager] ========== HOT CHANNEL PROCESSING FAILED ==========\n`);
        }
    },

    /**
     * Generate full summary when admin approves
     * @param {string} summaryId - ID of summary to generate
     * @param {Client} client - Discord client
     * @returns {Promise<void>}
     */
    async generateFullSummary(summaryId, client) {
        try {
            const summary = state.pendingSummaries[summaryId];
            if (!summary) {
                console.error(`[LLMSummaryManager] Summary not found: ${summaryId}`);
                return;
            }

            const llmConfig = config.LLM_SUMMARY || {};

            // Generate summary using LLM
            const fullSummary = await llmService.generateSummary(summary.messages);

            // Update state
            summary.status = 'completed';
            summary.fullSummary = fullSummary;
            summary.completedAt = Date.now();
            saveState();

            // 加入已摘要的指紋清單
            state.summarizedTopicFingerprints.push(summary.fingerprint);
            // 僅保留最近 1000 筆指紋，避免無限增長
            if (state.summarizedTopicFingerprints.length > 1000) {
                state.summarizedTopicFingerprints.shift();
            }
            saveState();

            // Post to summary channel
            const summaryChannel = client.channels.cache.get(llmConfig.channels.summary);
            if (summaryChannel) {
                await this._postSummary(summaryChannel, summary);
            }

            // Clean up from pending
            delete state.pendingSummaries[summaryId];
            saveState();

        } catch (error) {
            console.error('[LLMSummaryManager] Error generating summary:', error);

            // Mark as error
            const summary = state.pendingSummaries[summaryId];
            if (summary) {
                summary.status = 'error';
                summary.error = error.message;
                saveState();
            }
        }
    },

    /**
     * Reject a pending summary
     * @param {string} summaryId - ID of summary to reject
     * @returns {Promise<void>}
     */
    async rejectSummary(summaryId) {
        try {
            const summary = state.pendingSummaries[summaryId];
            if (!summary) {
                console.error(`[LLMSummaryManager] Summary not found: ${summaryId}`);
                return;
            }

            summary.status = 'rejected';
            summary.rejectedAt = Date.now();
            saveState();

            console.log(`[LLMSummaryManager] Summary rejected: ${summaryId}`);

            // Clean up after delay
            setTimeout(() => {
                delete state.pendingSummaries[summaryId];
                saveState();
            }, 60000);
        } catch (error) {
            console.error('[LLMSummaryManager] Error rejecting summary:', error);
        }
    },

    /**
     * Get pending summary by ID
     * @param {string} summaryId - Summary ID
     * @returns {Object} Summary object or null
     */
    getPendingSummary(summaryId) {
        return state.pendingSummaries[summaryId] || null;
    },

    /**
     * Check rate limit for a channel
     * @private
     * @param {string} channelId - Channel ID
     * @returns {boolean} True if within rate limit
     */
    _checkRateLimit(channelId) {
        const llmConfig = config.LLM_SUMMARY || {};
        const now = Date.now();

        // Check channel cooldown
        const lastCheck = state.rateLimits.channelCooldowns[channelId];
        if (lastCheck && now - lastCheck < llmConfig.rateLimits.cooldownBetweenChecks) {
            return false;
        }

        // Check hourly limit
        const currentHour = Math.floor(now / (60 * 60 * 1000));
        const hourKey = currentHour.toString();

        if (!state.rateLimits.hourlyRequests[hourKey]) {
            state.rateLimits.hourlyRequests[hourKey] = 0;
        }

        if (state.rateLimits.hourlyRequests[hourKey] >= llmConfig.rateLimits.maxRequestsPerHour) {
            return false;
        }

        // Record this request
        state.rateLimits.hourlyRequests[hourKey]++;
        state.rateLimits.channelCooldowns[channelId] = now;
        saveState();

        return true;
    },

    /**
     * Send admin notification with approval buttons
     * @private
     */
    async _sendAdminNotification(summaryId, channel, client, relevanceResult, stats, topicName = null) {
        try {
            const llmConfig = config.LLM_SUMMARY || {};
            const adminChannel = client.channels.cache.get(llmConfig.channels.adminApproval);

            if (!adminChannel) {
                console.warn('[LLMSummaryManager] Admin approval channel not found');
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(topicName ? `🔍 偵測到討論主題: ${topicName}` : '🔍 偵測到可能相關的遊戲開發討論')
                .setColor(CATEGORY_COLORS[relevanceResult.category] || 0x3498DB)
                .addFields(
                    { name: '頻道', value: `<#${channel.id}>`, inline: true },
                    { name: '訊息數', value: stats.totalMessages.toString(), inline: true },
                    { name: '參與人數', value: stats.uniqueAuthors.toString(), inline: true },
                    { name: '分類', value: this._getCategoryLabel(relevanceResult.category), inline: true },
                    { name: '原因', value: relevanceResult.reason || '無', inline: true },
                    {
                        name: '預估成本',
                        value: `${relevanceResult.tokenCount} tokens (~$${(relevanceResult.tokenCount / 1000000 * 0.35).toFixed(6)})${llmConfig.dryRun ? ' (Dry Run)' : ''}`,
                        inline: true
                    },
                )
                .setFooter({ text: `ID: ${summaryId}` })
                .setTimestamp();

            // 取得訊息預覽（使用已收集的訊息，避免重複呼叫 Discord API）
            const pendingSummary = state.pendingSummaries[summaryId];
            const previewMessages = (pendingSummary?.messages || []).slice(-3);
            const preview = conversationCollector.formatForLLM(previewMessages);
            if (preview.length > 1024) {
                embed.addFields({
                    name: '對話預覽',
                    value: preview.substring(0, 1021) + '...'
                });
            } else {
                embed.addFields({ name: '對話預覽', value: preview || '(無)' });
            }

            // Add buttons
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`summary_approve_${summaryId}`)
                        .setLabel('生成完整摘要')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅'),
                    new ButtonBuilder()
                        .setCustomId(`summary_reject_${summaryId}`)
                        .setLabel('忽略')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('❌')
                );

            await adminChannel.send({ embeds: [embed], components: [row] });
            console.log(`[LLMSummaryManager] Admin notification sent: ${summaryId}`);
        } catch (error) {
            console.error('[LLMSummaryManager] Failed to send admin notification:', error);
        }
    },

    /**
     * Post summary to summary channel
     * @private
     */
    async _postSummary(channel, summary) {
        try {
            const fullSummary = summary.fullSummary;
            const relevanceResult = summary.relevanceResult;

            const embed = new EmbedBuilder()
                .setTitle(`📝 ${fullSummary.title}${summary.topicName ? ` (${summary.topicName})` : ''}`)
                .setColor(CATEGORY_COLORS[relevanceResult.category] || 0x3498DB)
                .addFields(
                    { name: '摘要', value: fullSummary.summary || '(無)' },
                    {
                        name: '重點',
                        value: fullSummary.keyPoints.length > 0
                            ? fullSummary.keyPoints.join('\n')
                            : '(無)'
                    },
                    {
                        name: '參與者',
                        value: fullSummary.participants.length > 0
                            ? fullSummary.participants.join(', ')
                            : '(無)'
                    }
                );

            // Add resources if any
            if (fullSummary.resources.length > 0) {
                embed.addFields({
                    name: '資源連結',
                    value: fullSummary.resources.join('\n')
                });
            }

            // Add action items if any
            if (fullSummary.actionItems.length > 0) {
                embed.addFields({
                    name: '待辦事項',
                    value: fullSummary.actionItems.join('\n')
                });
            }

            embed
                .addFields({
                    name: '原始頻道',
                    value: `<#${summary.channelId}>`,
                    inline: true
                })
                .addFields({
                    name: '分類',
                    value: this._getCategoryLabel(relevanceResult.category),
                    inline: true
                })
                .setFooter({
                    text: `成本: ${fullSummary.tokenCount} tokens (~$${(fullSummary.tokenCount / 1000000 * 0.35).toFixed(6)})${config.LLM_SUMMARY.dryRun ? ' (Dry Run)' : ''}`
                })
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            console.log(`[LLMSummaryManager] Summary posted: ${summary.id}`);
        } catch (error) {
            console.error('[LLMSummaryManager] Failed to post summary:', error);
        }
    },

    /**
     * Generate unique ID
     * @private
     */
    _generateId() {
        return Math.random().toString(36).substring(2, 11);
    },

    /**
     * 為一組訊息 ID 產生唯一指紋
     * @private
     */
    _generateFingerprint(messageIds) {
        const sortedIds = [...messageIds].sort();
        return crypto.createHash('md5').update(sortedIds.join(',')).digest('hex');
    },

    /**
     * Get category display label
     * @private
     */
    _getCategoryLabel(category) {
        const labels = {
            technics: '🔧 技術',
            art: '🎨 美術',
            design: '🎮 設計',
            news: '📰 新聞',
            resource: '📚 資源',
            other: '❓ 其他'
        };
        return labels[category] || '❓ 其他';
    },

    /**
     * Clean up resources (for testing)
     * @internal
     */
    _cleanup() {
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
        }
    }
};
