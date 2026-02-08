# Gemini Context File (AGENTS.md)

## Project Overview
This is a **Node.js Discord Bot** project, "Game Night Castle Bot". It is designed to manage community interactions, events, statistics, and provide AI-powered discussion summaries. The bot uses `discord.js` (v14) for Discord API interactions and includes an Express server for keep-alive functionality.

## Tech Stack
*   **Runtime:** Node.js
*   **Framework:** `discord.js` (v14)
*   **AI/LLM:** `@google/generative-ai` (Gemini)
*   **Web Server:** `express` (used for health checks/keep-alive)
*   **Scheduling:** `node-cron`
*   **Utilities:** `dotenv`, `axios`, `cheerio`, `node-fetch`
*   **Language:** JavaScript (CommonJS)

## Architecture & Core Concepts

### 1. Entry Point (`index.js`)
*   Initializes the `Client` with specific intents (Guilds, Messages, Members, Voice, etc.).
*   Sets up an Express server on port 8080 (or `process.env.PORT`) to respond to health checks.
*   Loads event handlers from the `events/` directory.
*   Loads scheduled jobs from the `jobs/` directory (executed after the `ready` event).
*   Includes a self-ping mechanism to prevent sleep on some hosting platforms.

### 2. Command Handling
*   Commands are located in `commands/`.
*   Each file exports an object with `name`, `description`, and an `execute(message, args)` function.
*   **Note:** The bot currently uses message-based command handlers (processing `messageCreate` events) rather than Slash Commands (`/`).

### 3. Event Handling
*   Events are located in `events/`.
*   Each file exports `name`, `once` (boolean), and `execute(...args, client)`.
*   `events/ready.js`: Handles login logging, invite caching, and **initializes the daily statistics cron job**.

### 4. Key Features
*   **Daily Statistics:** Tracks message counts, voice channel duration, and "most reacted" messages. Reports generated daily at 00:00 (Asia/Taipei).
*   **LLM Discussion Summarization:** Automatically detects "hot" topics (via `activeChatManager`), checks relevance to game dev (via `llmService`), and generates comprehensive summaries using Gemini (via `llmSummaryManager`). Includes **token counting** and **Dry Run mode** for zero-cost workflow testing.
*   **Cost Control & Dry Run:** Every LLM interaction logs the estimated cost (USD) based on token counts. `LLM_DRY_RUN=true` allows full flow testing without calling the generative API.
*   **Load Testing:** Simulates user conversations to test the LLM summary feature (`commands/loadtest.js`).
*   **Invite Tracking:** Caches invite codes and usage counts.

## Configuration
*   **Central Config:** `config/config.js` is the single source of truth for constants, channel IDs, filters, and feature settings.
*   **Environment Variables:** Managed via `.env` (e.g., `TOKEN`, `PORT`, `GEMINI_API_KEY`, `EVENT_ANNOUNCE_CHANNEL`).
*   **State Persistence:**
    - `data/activeChatState.json`: Persists active chat monitoring state.
    - `data/llmSummaryState.json`: Persists pending summaries and rate limits.

## Development Conventions
*   **Style:** CommonJS (`require`).
*   **Formatting:** Standard JavaScript formatting.
*   **Language:** Comments and user-facing messages are in **Traditional Chinese**.
*   **Global State:** Runtime state is often attached to `client` or managed via singleton managers in `utils/`.
*   **Git Workflow:** Pull requests should target the `dev` branch.

## Build & Run
*   **Start:** `npm start` (Runs `node index.js`)
*   **Dev:** `npm run dev` (Runs `nodemon index.js`)
*   **Test:** `npm test` (Runs `jest`)
*   **Lint:** `npm run lint` (Runs `eslint .`)

## Key Files to Know
*   `index.js`: Main application logic.
*   `config/config.js`: Central configuration.
*   `utils/activeChatManager.js`: Detects high-activity channels.
*   `utils/llmSummaryManager.js`: Orchestrates the summarization workflow.
*   `utils/llmService.js`: Interface for Gemini API.
*   `commands/loadtest.js`: Tool for generating test conversations.

## Improvement TODOs
- [ ] **Refactor: Decouple Event Handlers:** Break down `interactionCreate.js` and `messageCreate.js` into dedicated services (e.g., `TicketService`, `SuggestionService`).
- [ ] **Migrate to Slash Commands:** Modernize the command handler to use Discord's Slash Command API (`interactionCreate`).
- [ ] **Infrastructure: Structured Logging:** Replace `console.log` with a structured logger to control verbosity and unify error handling.
- [ ] **Refactor: Extract Keep-Alive:** Move self-ping logic out of `index.js`.