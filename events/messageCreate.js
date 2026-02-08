const MessageService = require('../services/MessageService');

module.exports = {
  name: "messageCreate",
  async execute(message) {
    try {
      await MessageService.handleMessage(message);
    } catch (error) {
      console.error("[events/messageCreate] Unhandled error:", error);
    }
  },
};