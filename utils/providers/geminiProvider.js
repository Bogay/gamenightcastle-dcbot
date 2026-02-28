// utils/providers/geminiProvider.js
/**
 * Gemini LLM Provider - Uses Google's Generative AI API
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiProvider {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.client = new GoogleGenerativeAI(apiKey);
        this.name = 'gemini';
        this.retryAttempts = 3;
        this.retryDelay = 1000; // ms
    }

    /**
     * Send message to Gemini and get response
     * @param {string} systemPrompt - System instruction for the model
     * @param {string} userMessage - User message/question
     * @param {Object} options - Configuration options
     * @param {number} attempt - Current retry attempt
     * @returns {Promise<string>} Model response text
     */
    async chat(systemPrompt, userMessage, options = {}, attempt = 0) {
        const model = options.model || 'gemini-2.0-flash';
        const timeout = options.timeout || 60000;

        try {
            const isGemma = model.toLowerCase().includes('gemma');
            const modelOptions = {
                model: model,
                generationConfig: {
                    temperature: 0.7,
                    topP: 0.95,
                    topK: 64,
                    maxOutputTokens: 2048,
                    responseMimeType: 'text/plain'
                }
            };

            // Gemma and some older models don't support systemInstruction
            if (!isGemma) {
                modelOptions.systemInstruction = systemPrompt;
            }

            const generativeModel = this.client.getGenerativeModel(modelOptions);

            const finalUserMessage = isGemma 
                ? `${systemPrompt}\n\n${userMessage}`
                : userMessage;

            // Execute with timeout
            const response = await Promise.race([
                generativeModel.generateContent(finalUserMessage),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('LLM request timeout')), timeout)
                )
            ]);

            const text = response.response.text();
            return text;
        } catch (error) {
            // Handle specific Gemini errors
            const errorMessage = error.message || '';
            const isRateLimit = errorMessage.includes('429') || 
                               errorMessage.includes('too many') || 
                               errorMessage.includes('Rate limit');

            if (isRateLimit && attempt < this.retryAttempts) {
                // Rate limited - use exponential backoff
                return this._retryWithBackoff(systemPrompt, userMessage, options, attempt);
            }

            console.error(`[GeminiProvider] Error: ${errorMessage}`);
            throw error;
        }
    }

    /**
     * Retry with exponential backoff for rate limits
     * @private
     */
    async _retryWithBackoff(systemPrompt, userMessage, options, attempt) {
        const delayMs = this.retryDelay * Math.pow(2, attempt);
        console.log(`[GeminiProvider] Rate limited, retrying in ${delayMs}ms (attempt ${attempt + 1}/${this.retryAttempts})`);

        await new Promise(resolve => setTimeout(resolve, delayMs));

        return this.chat(systemPrompt, userMessage, options, attempt + 1);
    }

    /**
     * Get provider name
     * @returns {string} Provider name
     */
    getName() {
        return this.name;
    }

    /**
     * Test API key validity
     * @returns {Promise<boolean>} True if API key is valid
     */
    async testConnection() {
        try {
            const model = this.client.getGenerativeModel({ model: 'gemini-2.0-flash' });
            await model.generateContent('test');
            return true;
        } catch (error) {
            console.error('[GeminiProvider] Connection test failed:', error);
            return false;
        }
    }

    /**
     * Count tokens for a given prompt
     * @param {string} systemPrompt 
     * @param {string} userMessage 
     * @param {Object} options 
     * @returns {Promise<number>} Total token count
     */
    async countTokens(systemPrompt, userMessage, options = {}) {
        const modelName = options.model || 'gemini-2.0-flash';
        
        try {
            const model = this.client.getGenerativeModel({ model: modelName });
            
            // Format content for token counting
            // Note: systemInstruction is not directly supported in countTokens for all SDK versions,
            // so we concatenate for estimation if needed, but best practice is to pass it if supported.
            // For simplicity and safety with current SDK:
            const result = await model.countTokens(systemPrompt + "\n\n" + userMessage);
            return result.totalTokens;
        } catch (error) {
            console.error('[GeminiProvider] Token counting failed:', error);
            return 0;
        }
    }
}

module.exports = GeminiProvider;
