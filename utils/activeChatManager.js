// utils/activeChatManager.js
const fs = require('fs');
const path = require('path');
const config = require('../config/config.js');
const llmService = require('./llmService.js');
const conversationCollector = require('./conversationCollector.js');

const STATE_FILE_PATH = path.join(__dirname, '../data/activeChatState.json');

const CONFIG = {
    targetGuildId: config.TARGET_GUILD_ID,
    notificationChannelId: config.CHANNELS.LEADERBOARD,
    ignoredCategories: config.ACTIVE_CHAT.IGNORED_CATEGORIES,
    rule1: config.ACTIVE_CHAT.RULE1,
    rule2: config.ACTIVE_CHAT.RULE2,
    cooldownTime: config.ACTIVE_CHAT.COOLDOWN,
    useLlmFilter: config.ACTIVE_CHAT.USE_LLM_FILTER
};

// 計算最長需要的時間區間 (取兩條規則中時間較長的那個)
// 用於判斷「閒置重置」
const MAX_DURATION = Math.max(CONFIG.rule1.duration, CONFIG.rule2.duration);

// State Data
let channelMessages = new Map();
let channelCooldowns = new Map();
let lastResetDate = new Date().toDateString();

// --- Persistence Helpers ---
function loadState() {
    if (!fs.existsSync(STATE_FILE_PATH)) return;
    try {
        const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
        const data = JSON.parse(raw);
        
        if (data.messages) {
            channelMessages = new Map(Object.entries(data.messages));
        }
        if (data.cooldowns) {
            channelCooldowns = new Map(Object.entries(data.cooldowns));
        }
        if (data.lastResetDate) {
            lastResetDate = data.lastResetDate;
        }
        // console.log(`[ActiveChat] State loaded. Tracking ${channelMessages.size} channels.`);
    } catch (err) {
        console.error('[ActiveChat] Failed to load state:', err);
    }
}

function saveState() {
    try {
        const data = {
            messages: Object.fromEntries(channelMessages),
            cooldowns: Object.fromEntries(channelCooldowns),
            lastResetDate: lastResetDate
        };
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('[ActiveChat] Failed to save state:', err);
    }
}

// Load state on startup
loadState();

module.exports = {
    async handleMessage(message) {
        // Debug: Log all incoming messages
        const isWebhook = message.webhookId ? '🔗 WEBHOOK' : 'USER';
        console.log(`[ActiveChat] Handling ${isWebhook} @${message.author.username} in #${message.channel.name}`);

        // 基本檢查 log
        if (!message.guild || message.guild.id !== CONFIG.targetGuildId) {
            console.log(`[ActiveChat] Skipped: Guild ID mismatch (expected: ${CONFIG.targetGuildId}, got: ${message.guild?.id})`);
            return;
        }

        if (message.author.bot) {
            console.log(`[ActiveChat] Skipped: Bot message`);
            return;
        }

        if (CONFIG.ignoredCategories.includes(message.channel.parentId)) {
            console.log(`[ActiveChat] Skipped: Category ignored (${message.channel.parentId})`);
            return;
        }

        if (message.channel.id === CONFIG.notificationChannelId) {
            console.log(`[ActiveChat] Skipped: Notification channel`);
            return;
        }

        console.log(`[ActiveChat] ✅ Message passed all initial checks`);

        checkDailyReset();

        const channelId = message.channel.id;
        const now = Date.now();

        // 檢查冷卻
        if (channelCooldowns.has(channelId)) {
            const lastTrigger = channelCooldowns.get(channelId);
            const timeLeft = CONFIG.cooldownTime - (now - lastTrigger);
            if (timeLeft > 0) {
                console.log(`[ActiveChat] 冷卻中... 剩餘 ${(timeLeft / 1000).toFixed(1)} 秒`);
                return;
            } else {
                // 冷卻結束，移除標記
                channelCooldowns.delete(channelId);
                saveState(); // Update state
            }
        }

        if (!channelMessages.has(channelId)) channelMessages.set(channelId, []);
        let msgs = channelMessages.get(channelId);

        // 閒置重置檢查 (避免隔太久突然觸發)
        if (msgs.length > 0) {
            const lastMsgTime = msgs[msgs.length - 1].timestamp;
            if (now - lastMsgTime > MAX_DURATION) {
                // console.log(`[ActiveChat] 頻道 ${message.channel.name} 閒置過久，重置計數器。`);
                msgs = []; // 清空陣列
                channelMessages.set(channelId, msgs); // 更新 Map
            }
        }

        msgs.push({ authorId: message.author.id, timestamp: now });

        // 再次過濾：只保留時間範圍內的訊息 (Double Check，確保滑動視窗準確)
        const validMsgs = msgs.filter(m => now - m.timestamp < MAX_DURATION);
        channelMessages.set(channelId, validMsgs);
        
        // Save state after updating messages
        saveState();

        // Debug 訊息 (測試完可註解)
         const uniqueUsers = new Set(validMsgs.map(m => m.authorId)).size;
         console.log(`[ActiveChat] ${message.channel.name} | 訊息: ${validMsgs.length} | 人數: ${uniqueUsers}`);

        // 判斷是否達標
        if (checkRule(validMsgs, CONFIG.rule1, now) || checkRule(validMsgs, CONFIG.rule2, now)) {
            let shouldNotify = true;

            // --- LLM Chitchat Filtering (Gemma 3) ---
            if (CONFIG.useLlmFilter) {
                console.log(`[ActiveChat] 🚀 Threshold met in #${message.channel.name}. Performing LLM relevance check...`);
                try {
                    // Collect recent messages for LLM context (e.g., last 20 messages)
                    const contextMsgs = await conversationCollector.collectMessages(message.channel, 20);
                    const relevanceResult = await llmService.quickRelevanceCheck(contextMsgs);

                    console.log(`[ActiveChat] LLM Relevance: ${relevanceResult.isRelevant} (${relevanceResult.category}) | Reason: ${relevanceResult.reason}`);

                    if (!relevanceResult.isRelevant) {
                        console.log(`[ActiveChat] 🤫 Chitchat filtered. Skipping notification.`);
                        shouldNotify = false;
                    }
                } catch (llmError) {
                    console.error(`[ActiveChat] LLM Relevance check failed:`, llmError);
                    // On error, we default to sending notification anyway (fail-safe)
                    console.log(`[ActiveChat] Proceeding with notification due to LLM error.`);
                }
            }

            if (shouldNotify) {
                await sendNotification(message.guild, message.channel);
            }

            // 通知發送成功後（或被過濾後），馬上清空該頻道的累積訊息
            // 這樣下次必須從 0 開始累積，不會因為冷卻結束就馬上再次觸發
            channelMessages.set(channelId, []);
            saveState(); // Update state
            console.log(`[ActiveChat] 計數器已清空 (#${message.channel.name})`);
        }
    },

    /**
     * 重置所有狀態 (僅供測試使用)
     */
    resetState() {
        channelMessages.clear();
        channelCooldowns.clear();
        console.log('[ActiveChat] State reset.');
    }
};

function checkRule(msgs, rule, now) {
    // 1. 先篩選時間內的訊息
    const recentMsgs = msgs.filter(m => now - m.timestamp < rule.duration);
    console.log(`[ActiveChat] [Rule Check] Duration: ${rule.duration}ms, Recent messages in window: ${recentMsgs.length}/${msgs.length}`);

    // 2. 計算「有效訊息數」 (套用單人上限)
    const userCounts = {};
    let effectiveMsgCount = 0;
    const uniqueUsers = new Set();

    for (const msg of recentMsgs) {
        uniqueUsers.add(msg.authorId);

        // 初始化該使用者的計數
        if (!userCounts[msg.authorId]) userCounts[msg.authorId] = 0;

        // 只有在未達上限時，才增加「有效訊息數」
        if (userCounts[msg.authorId] < rule.maxContribution) {
            userCounts[msg.authorId]++;
            effectiveMsgCount++;
        }
    }

    const ruleName = rule.minUsers === 3 && rule.minMsgs === 10 ? 'Rule 1' : 'Rule 2';
    const userCheck = `👥 ${uniqueUsers.size}/${rule.minUsers} users`;
    const msgCheck = `💬 ${effectiveMsgCount}/${rule.minMsgs} effective messages`;
    const passed = uniqueUsers.size >= rule.minUsers && effectiveMsgCount >= rule.minMsgs;
    const status = passed ? '✅' : '❌';

    console.log(`[ActiveChat] [${ruleName}] ${status} ${userCheck} | ${msgCheck}`);

    // 3. 判定條件
    if (uniqueUsers.size < rule.minUsers) return false;
    if (effectiveMsgCount < rule.minMsgs) return false;

    return true;
}

function checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        console.log("[ActiveChat] 執行每日重置");
        lastResetDate = today;
        channelCooldowns.clear();
        // 每日重置時，建議也可以順便清空所有累積訊息，避免隔日第一則訊息就觸發舊的
        channelMessages.clear();
        saveState(); // Save after reset
    }
}

async function sendNotification(guild, activeChannel) {
    try {
        const notifyChannel = guild.channels.cache.get(CONFIG.notificationChannelId);
        if (!notifyChannel) return console.log("⚠️ 活躍通知失敗：找不到通知頻道 ID");

        channelCooldowns.set(activeChannel.id, Date.now());
        saveState(); // Save cooldown

        await notifyChannel.send({
            content: `<#${activeChannel.id}> 現在討論得很熱烈 🔥，趕快去看看吧！`
        });
    } catch (error) {
        console.error("發送活躍通知失敗:", error);
    }
}
