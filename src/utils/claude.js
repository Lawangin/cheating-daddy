const { Anthropic } = require('@anthropic-ai/sdk');

const CLAUDE_MODEL = 'claude-opus-4-8';

// ── State ──

let client = null;
let claudeSystemPrompt = null;
let webSearchEnabled = false;
let claudeConversationHistory = [];

// Lazy require to avoid circular dependency (gemini.js lazy-requires claude.js)
function getGemini() {
    return require('./gemini');
}

// ── Lifecycle ──

function initializeClaudeProvider({ apiKey, systemPrompt, enableWebSearch }) {
    client = new Anthropic({ apiKey });
    claudeSystemPrompt = systemPrompt || 'You are a helpful assistant.';
    webSearchEnabled = !!enableWebSearch;
    claudeConversationHistory = [];
    console.log('[Claude] Provider initialized, web search:', webSearchEnabled);
}

function closeClaudeProvider() {
    client = null;
    claudeSystemPrompt = null;
    claudeConversationHistory = [];
    console.log('[Claude] Provider closed');
}

function isClaudeConfigured() {
    return client !== null;
}

// ── Helpers ──

function buildTools() {
    if (!webSearchEnabled) return [];
    return [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
}

function trimHistory() {
    while (claudeConversationHistory.length > 20) {
        claudeConversationHistory.splice(0, 2);
    }
}

function statusForError(error) {
    if (error instanceof Anthropic.AuthenticationError) return 'Claude error: invalid API key';
    if (error instanceof Anthropic.RateLimitError) return 'Claude rate limited — retrying shortly';
    if (error instanceof Anthropic.APIConnectionError) return 'Claude error: network issue';
    return 'Claude error: ' + error.message;
}

// ── Chat (transcriptions and typed text) ──

async function sendToClaude(text) {
    if (!client) {
        console.error('[Claude] Not initialized');
        return;
    }
    const { sendToRenderer, saveConversationTurn } = getGemini();

    claudeConversationHistory.push({ role: 'user', content: text.trim() });
    trimHistory();

    try {
        const stream = client.messages.stream({
            model: CLAUDE_MODEL,
            max_tokens: 1024,
            system: claudeSystemPrompt,
            messages: claudeConversationHistory,
            tools: buildTools(),
        });

        let fullText = '';
        let isFirst = true;
        stream.on('text', delta => {
            fullText += delta;
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
            isFirst = false;
        });

        await stream.finalMessage();

        if (fullText.trim()) {
            claudeConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(text, fullText);
        }

        console.log('[Claude] Response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[Claude] API error:', error);
        // Drop the unanswered user turn so history stays consistent
        claudeConversationHistory.pop();
        sendToRenderer('update-status', statusForError(error));
    }
}

// ── Screenshot analysis ──

async function sendImageToClaude(base64Data, prompt) {
    if (!client) {
        return { success: false, error: 'Claude not initialized' };
    }
    const { sendToRenderer, saveScreenAnalysis } = getGemini();

    try {
        console.log(`[Claude] Sending image to ${CLAUDE_MODEL} (streaming)...`);
        const stream = client.messages.stream({
            model: CLAUDE_MODEL,
            max_tokens: 2048,
            system: claudeSystemPrompt,
            messages: [
                ...claudeConversationHistory,
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
                        },
                        { type: 'text', text: prompt },
                    ],
                },
            ],
        });

        let fullText = '';
        let isFirst = true;
        stream.on('text', delta => {
            fullText += delta;
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
            isFirst = false;
        });

        await stream.finalMessage();

        // Store text-only versions in history (mirrors local mode behavior)
        if (fullText.trim()) {
            claudeConversationHistory.push({ role: 'user', content: prompt });
            claudeConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            trimHistory();
        }

        console.log('[Claude] Image response completed');
        saveScreenAnalysis(prompt, fullText, CLAUDE_MODEL);
        return { success: true, text: fullText, model: CLAUDE_MODEL };
    } catch (error) {
        console.error('[Claude] Image error:', error);
        sendToRenderer('update-status', statusForError(error));
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeClaudeProvider,
    closeClaudeProvider,
    isClaudeConfigured,
    sendToClaude,
    sendImageToClaude,
};
