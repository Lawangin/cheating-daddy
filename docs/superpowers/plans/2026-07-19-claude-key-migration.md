# Claude Key Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gemini API key with a Claude (Anthropic) API key in BYOK mode: Whisper (local) transcribes audio, Claude answers everything (chat, transcription answers, screenshots).

**Architecture:** Electron main process. `src/utils/gemini.js` keeps its filename and IPC channel names (renderer contract unchanged) but its BYOK internals switch from a Gemini Live session to the shared Whisper/VAD pipeline in `src/utils/localai.js` plus a new `src/utils/claude.js` provider. Groq stays as the optional fast-answer path. Local and cloud modes are untouched.

**Tech Stack:** Electron 30, CommonJS (`require`), `@anthropic-ai/sdk` (new), `@huggingface/transformers` (existing Whisper), pnpm.

**Spec:** `docs/superpowers/specs/2026-07-19-claude-key-migration-design.md`

## Global Constraints

- No test framework exists in this repo — verification is `node --check <file>` for syntax plus manual `pnpm start` smoke tests. Do not add a test framework.
- Claude model is exactly `claude-opus-4-8` everywhere.
- IPC channel names must NOT change (`initialize-gemini`, `send-text-message`, `send-image-content`, `send-audio-content`, `send-mic-audio-content`, `close-session`).
- Renderer talks to storage via existing `cheatingDaddy.storage` IPC — do not touch preload.
- pnpm is the package manager (`pnpm add` / `pnpm remove`).
- Circular-dependency rule in this codebase: `localai.js`/`claude.js` may `require('./gemini')` **lazily inside functions only**; `gemini.js` lazy-requires them via getter functions.

---

### Task 1: Add SDK and create `src/utils/claude.js`

**Files:**
- Modify: `package.json` (via pnpm)
- Create: `src/utils/claude.js`

**Interfaces:**
- Consumes (from `./gemini`, lazy-required at call time; `saveScreenAnalysis` export is added in Task 3): `sendToRenderer(channel, data)`, `saveConversationTurn(transcription, aiResponse)`, `saveScreenAnalysis(prompt, response, model)`
- Produces (used by Task 3):
  - `initializeClaudeProvider({ apiKey, systemPrompt, enableWebSearch })` → void
  - `closeClaudeProvider()` → void
  - `isClaudeConfigured()` → boolean
  - `sendToClaude(text)` → Promise<void> (streams to renderer, saves turn)
  - `sendImageToClaude(base64Data, prompt)` → Promise<{success, text?, model?, error?}>

- [ ] **Step 1: Install the SDK**

Run: `pnpm add @anthropic-ai/sdk`
Expected: `@anthropic-ai/sdk` appears under `dependencies` in `package.json`; install completes without errors.

- [ ] **Step 2: Verify the CJS named export works**

Run: `node -e "const { Anthropic } = require('@anthropic-ai/sdk'); console.log(typeof Anthropic, typeof Anthropic.RateLimitError)"`
Expected: `function function`
(If it prints `undefined`, use `const Anthropic = require('@anthropic-ai/sdk').default` instead in Step 3 — but current SDK versions export both.)

- [ ] **Step 3: Create `src/utils/claude.js`**

```javascript
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
    if (claudeConversationHistory.length > 20) {
        claudeConversationHistory = claudeConversationHistory.slice(-20);
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
```

- [ ] **Step 4: Syntax check**

Run: `node --check src/utils/claude.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/utils/claude.js
git commit -m "feat: add Claude provider module using @anthropic-ai/sdk"
```

---

### Task 2: Make the Whisper transcription sink configurable in `src/utils/localai.js`

**Files:**
- Modify: `src/utils/localai.js`

**Interfaces:**
- Produces (used by Task 3): `initializeByokAudioSession(whisperModel, sink)` → Promise<boolean>, where `sink` is `async (transcription: string) => void`. Existing exports unchanged in signature: `initializeLocalSession`, `processLocalAudio`, `closeLocalSession`, `isLocalSessionActive`, `sendLocalText`, `sendLocalImage`.

- [ ] **Step 1: Add sink state**

In the `// ── State ──` block (after `let isLocalActive = false;`), add:

```javascript
// Where finished transcriptions are sent. Local mode sets this to sendToOllama;
// BYOK mode injects a Claude/Groq sink via initializeByokAudioSession.
let transcriptionSink = null;
```

- [ ] **Step 2: Route `handleSpeechEnd` through the sink**

In `handleSpeechEnd`, replace the final line:

```javascript
    sendToRenderer('update-status', 'Generating response...');
    await sendToOllama(transcription);
```

with:

```javascript
    sendToRenderer('update-status', 'Generating response...');
    await (transcriptionSink || sendToOllama)(transcription);
```

- [ ] **Step 3: Set the sink in `initializeLocalSession`**

In `initializeLocalSession`, in the `// Reset VAD state` block (after `localConversationHistory = [];`), add:

```javascript
        transcriptionSink = sendToOllama;
```

- [ ] **Step 4: Add `initializeByokAudioSession`**

Add after `initializeLocalSession` (before `processLocalAudio`):

```javascript
// BYOK mode: Whisper transcription only — no Ollama. Transcriptions go to the
// injected sink (Groq or Claude, decided by gemini.js).
async function initializeByokAudioSession(whisperModel, sink) {
    console.log('[LocalAI] Initializing BYOK audio session (Whisper only):', { whisperModel });

    const pipeline = await loadWhisperPipeline(whisperModel);
    if (!pipeline) {
        return false;
    }

    // Reset VAD state
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);

    ollamaClient = null;
    ollamaModel = null;
    localConversationHistory = [];
    transcriptionSink = sink;
    isLocalActive = true;

    console.log('[LocalAI] BYOK audio session initialized');
    return true;
}
```

- [ ] **Step 5: Clear the sink in `closeLocalSession`**

In `closeLocalSession`, after `isLocalActive = false;`, add:

```javascript
    transcriptionSink = null;
```

- [ ] **Step 6: Export it**

In `module.exports`, add `initializeByokAudioSession,` after `initializeLocalSession,`.

- [ ] **Step 7: Syntax check**

Run: `node --check src/utils/localai.js`
Expected: no output (exit 0).

- [ ] **Step 8: Commit**

```bash
git add src/utils/localai.js
git commit -m "feat: make Whisper transcription sink configurable for BYOK mode"
```

---

### Task 3: Rewire BYOK in `src/utils/gemini.js` (remove Gemini, use Whisper + Claude)

**Files:**
- Modify: `src/utils/gemini.js`

**Interfaces:**
- Consumes: `initializeByokAudioSession(whisperModel, sink)` (Task 2); `initializeClaudeProvider`, `closeClaudeProvider`, `sendToClaude`, `sendImageToClaude` (Task 1); `getPreferences` from `../storage`.
- Produces: adds `saveScreenAnalysis` to `module.exports` (consumed by claude.js). Removes exports: `initializeGeminiSession`, `sendAudioToGemini`, `sendImageToGeminiHttp`, `formatSpeakerResults`. Keeps everything else exported as-is (verified: `index.js` imports only `setupGeminiIpcHandlers`, `stopMacOSAudioCapture`, `sendToRenderer`; `localai.js` imports `sendToRenderer`, `initializeNewSession`, `saveConversationTurn`).

- [ ] **Step 1: Update imports and module state**

Replace line 1:

```javascript
const { GoogleGenAI, Modality } = require('@google/genai');
```

with nothing (delete it). Replace the storage import (line 6):

```javascript
const { getAvailableModel, incrementLimitCount, getApiKey, getGroqApiKey, incrementCharUsage, getModelForToday } = require('../storage');
```

with:

```javascript
const { getApiKey, getGroqApiKey, incrementCharUsage, getModelForToday, getPreferences } = require('../storage');
```

After the existing `getLocalAi()` lazy getter, add:

```javascript
// Lazy-loaded to avoid circular dependency (claude.js lazy-requires gemini.js)
let _claude = null;
function getClaude() {
    if (!_claude) _claude = require('./claude');
    return _claude;
}
```

Delete these now-unused declarations and their comments:
- `let messageBuffer = '';`
- the whole `// Reconnection variables` block (`isUserClosing`, `sessionParams`, `reconnectAttempts`, `MAX_RECONNECT_ATTEMPTS`, `RECONNECT_DELAY`)

- [ ] **Step 2: Delete dead Gemini functions**

Delete entirely (function bodies plus any `module.exports.X = X` lines for them):
- `formatSpeakerResults` (and its `module.exports.formatSpeakerResults = formatSpeakerResults;` line)
- `buildContextMessage`
- `sendToGemma` and `trimConversationHistoryForGemma`
- `initializeGeminiSession`
- `attemptReconnect`
- `sendAudioToGemini`
- `sendImageToGeminiHttp`

Keep: `sendToGroq`, `stripThinkingTags`, `hasGroqKey`, `getEnabledTools`, `getStoredSetting`, `saveScreenAnalysis`, all audio-capture functions, session-tracking functions.

- [ ] **Step 3: Add `initializeClaudeSession`**

Where `initializeGeminiSession` was, add:

```javascript
async function initializeClaudeSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US') {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    sendToRenderer('session-initializing', true);

    try {
        // Web search toggle re-uses the existing "Google Search" setting
        const enabledTools = await getEnabledTools();
        const webSearchEnabled = enabledTools.some(tool => tool.googleSearch);

        const systemPrompt = getSystemPrompt(profile, customPrompt, webSearchEnabled);
        currentSystemPrompt = systemPrompt; // Also used by the Groq path

        initializeNewSession(profile, customPrompt);

        getClaude().initializeClaudeProvider({ apiKey, systemPrompt, enableWebSearch: webSearchEnabled });

        const whisperModel = (getPreferences().whisperModel) || 'Xenova/whisper-small';
        const ok = await getLocalAi().initializeByokAudioSession(whisperModel, async transcription => {
            if (hasGroqKey()) {
                await sendToGroq(transcription);
            } else {
                await getClaude().sendToClaude(transcription);
            }
        });

        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        if (ok) {
            sendToRenderer('update-status', 'Listening...');
        } else {
            sendToRenderer('update-status', 'Failed to load Whisper model');
        }
        return ok;
    } catch (error) {
        console.error('Failed to initialize Claude session:', error);
        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return false;
    }
}
```

- [ ] **Step 4: Route BYOK audio to Whisper**

In `startMacOSAudioCapture`'s chunk loop, replace:

```javascript
            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else {
                const base64Data = monoChunk.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }
```

with:

```javascript
            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else {
                // 'local' and 'byok' both transcribe via the local Whisper pipeline
                getLocalAi().processLocalAudio(monoChunk);
            }
```

In the `send-audio-content` handler, replace the trailing BYOK branch (from `if (!geminiSessionRef.current)` through its closing `}` of the try/catch) with:

```javascript
        try {
            const pcmBuffer = Buffer.from(data, 'base64');
            getLocalAi().processLocalAudio(pcmBuffer);
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
```

Apply the same replacement to the trailing BYOK branch of `send-mic-audio-content` (error message `'Error sending mic audio:'`).

- [ ] **Step 5: Update the `initialize-gemini` IPC handler (channel name unchanged)**

Replace:

```javascript
    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });
```

with:

```javascript
    // Channel name kept for renderer compatibility; BYOK now runs Whisper + Claude
    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';
        return await initializeClaudeSession(apiKey, customPrompt, profile, language);
    });
```

- [ ] **Step 6: Update image and text handlers' BYOK branches**

In `send-image-content`, replace:

```javascript
            // Use HTTP API instead of realtime session
            const result = await sendImageToGeminiHttp(data, prompt);
            return result;
```

with:

```javascript
            const result = await getClaude().sendImageToClaude(data, prompt);
            return result;
```

In `send-text-message`, replace the trailing BYOK branch (from `if (!geminiSessionRef.current)` through the end of its try/catch) with:

```javascript
        try {
            console.log('Sending text message:', text);
            if (hasGroqKey()) {
                await sendToGroq(text.trim());
            } else {
                await getClaude().sendToClaude(text.trim());
            }
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
```

- [ ] **Step 7: Update `close-session` BYOK branch**

Replace the BYOK tail of the `close-session` handler (everything after the `local` branch inside the try):

```javascript
            // Set flag to prevent reconnection attempts
            isUserClosing = true;
            sessionParams = null;

            // Cleanup session
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            }

            return { success: true };
```

with:

```javascript
            getLocalAi().closeLocalSession();
            getClaude().closeClaudeProvider();
            geminiSessionRef.current = null;

            return { success: true };
```

- [ ] **Step 8: Update `module.exports`**

Replace the export block at the bottom with:

```javascript
module.exports = {
    initializeClaudeSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    saveScreenAnalysis,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    setupGeminiIpcHandlers,
};
```

- [ ] **Step 9: Verify no dangling references**

Run: `node --check src/utils/gemini.js && grep -n "GoogleGenAI\|sendToGemma\|sendAudioToGemini\|sendImageToGeminiHttp\|initializeGeminiSession\|attemptReconnect\|isUserClosing\|sessionParams\|reconnectAttempts\|formatSpeakerResults\|buildContextMessage\|messageBuffer\|getAvailableModel\|incrementLimitCount" src/utils/gemini.js src/utils/localai.js src/index.js src/utils/window.js; echo "grep-exit:$?"`
Expected: `node --check` silent; grep prints nothing and `grep-exit:1` (no matches).

- [ ] **Step 10: Commit**

```bash
git add src/utils/gemini.js
git commit -m "feat: BYOK mode uses Whisper + Claude instead of Gemini Live"
```

---

### Task 4: Update BYOK UI in `src/components/views/MainView.js`

**Files:**
- Modify: `src/components/views/MainView.js`

**Interfaces:**
- Consumes: existing `cheatingDaddy.storage.setApiKey/getApiKey` (unchanged — the slot now holds a Claude key).
- Produces: no API changes; internal rename `_geminiKey` → `_claudeKey`, `_saveGeminiKey` → `_saveClaudeKey`.

- [ ] **Step 1: Rename state field and setter**

- In the constructor: `this._geminiKey = '';` → `this._claudeKey = '';`
- In `_loadFromStorage()`: `this._geminiKey = await cheatingDaddy.storage.getApiKey()...` → `this._claudeKey = await cheatingDaddy.storage.getApiKey().catch(() => '') || '';`
- Rename the method:

```javascript
    async _saveClaudeKey(val) {
        this._claudeKey = val;
        this._keyError = false;
        await cheatingDaddy.storage.setApiKey(val);
        this.requestUpdate();
    }
```

- In `_handleStart()`: `if (!this._geminiKey.trim())` → `if (!this._claudeKey.trim())`

- [ ] **Step 2: Update the BYOK form**

In `_renderByokMode()`, replace the Gemini key form-group:

```javascript
            <div class="form-group">
                <label class="form-label">Gemini API Key</label>
                <input
                    type="password"
                    placeholder="Required"
                    .value=${this._geminiKey}
                    @input=${e => this._saveGeminiKey(e.target.value)}
                    class=${this._keyError ? 'error' : ''}
                />
                <div class="form-hint">
                    <span class="link" @click=${() => this.onExternalLink('https://aistudio.google.com/apikey')}>Get Gemini key</span>
                </div>
            </div>
```

with:

```javascript
            <div class="form-group">
                <label class="form-label">Claude API Key</label>
                <input
                    type="password"
                    placeholder="Required"
                    .value=${this._claudeKey}
                    @input=${e => this._saveClaudeKey(e.target.value)}
                    class=${this._keyError ? 'error' : ''}
                />
                <div class="form-hint">
                    <span class="link" @click=${() => this.onExternalLink('https://platform.claude.com/settings/keys')}>Get Claude key</span>
                </div>
            </div>
```

- [ ] **Step 3: Add the Whisper model picker to the BYOK form**

BYOK now transcribes with Whisper. In `_renderByokMode()`, after the Groq form-group and before `${this._renderStartButton()}`, add (copied from `_renderLocalMode()`):

```javascript
            <div class="form-group">
                <div class="whisper-label-row">
                    <label class="form-label">Whisper Model</label>
                    ${this.whisperDownloading ? html`<div class="whisper-spinner"></div>` : ''}
                </div>
                <select
                    .value=${this._whisperModel}
                    @change=${e => this._saveWhisperModel(e.target.value)}
                >
                    <option value="Xenova/whisper-tiny" ?selected=${this._whisperModel === 'Xenova/whisper-tiny'}>Tiny (fastest, least accurate)</option>
                    <option value="Xenova/whisper-base" ?selected=${this._whisperModel === 'Xenova/whisper-base'}>Base</option>
                    <option value="Xenova/whisper-small" ?selected=${this._whisperModel === 'Xenova/whisper-small'}>Small (recommended)</option>
                    <option value="Xenova/whisper-medium" ?selected=${this._whisperModel === 'Xenova/whisper-medium'}>Medium (most accurate, slowest)</option>
                </select>
                <div class="form-hint">${this.whisperDownloading ? 'Downloading model...' : 'Used to transcribe audio locally. Downloaded automatically on first use'}</div>
            </div>
```

- [ ] **Step 4: Verify rename is complete**

Run: `grep -n "_geminiKey\|_saveGeminiKey" src/components/views/MainView.js; echo "grep-exit:$?"`
Expected: no matches, `grep-exit:1`.

- [ ] **Step 5: Commit**

```bash
git add src/components/views/MainView.js
git commit -m "feat: BYOK UI takes a Claude API key and exposes Whisper model picker"
```

---

### Task 5: Cleanup — storage comments and `@google/genai` removal

**Files:**
- Modify: `package.json` (via pnpm), possibly `src/storage.js`

- [ ] **Step 1: Confirm `@google/genai` is unreferenced**

Run: `grep -rn "@google/genai\|GoogleGenAI" src/ --include="*.js"; echo "grep-exit:$?"`
Expected: no matches, `grep-exit:1`. (If anything matches, stop and fix that reference first.)

- [ ] **Step 2: Remove the dependency**

Run: `pnpm remove @google/genai`
Expected: removed from `package.json` dependencies; install completes.

- [ ] **Step 3: Check whether Gemini rate-limit helpers are still referenced**

Run: `grep -rn "getAvailableModel\|incrementLimitCount" src/ --include="*.js" | grep -v "src/storage.js"`
Expected: no matches. If none: in `src/storage.js`, delete the `incrementLimitCount` and `getAvailableModel` function definitions and their two lines in `module.exports`. Leave `getLimits`/`setLimits`/`getTodayLimits`/`incrementCharUsage`/`getModelForToday` alone (Groq still uses them, and `getTodayLimits` may be IPC-exposed).
If there ARE matches outside storage.js, leave storage.js untouched.

- [ ] **Step 4: Syntax check**

Run: `node --check src/storage.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/storage.js
git commit -m "chore: drop @google/genai and dead Gemini rate-limit helpers"
```

---

### Task 6: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Launch the app**

Run: `pnpm start`
Expected: window opens, no main-process errors in the terminal. Warnings about DevTools are fine.

- [ ] **Step 2: BYOK form check**

In the app: the BYOK form shows "Claude API Key" (required), "Groq API Key" (optional), and the Whisper model select. The "Get Claude key" link opens the Anthropic Console.

- [ ] **Step 3: Start a session without a key**

Click start with an empty Claude key → the key input shows the error state, session does not start.

- [ ] **Step 4: Start a session with a Claude key**

Enter a valid Anthropic key (`sk-ant-...`), click start. Expected terminal output: `[LocalAI] Loading Whisper model...` (first run downloads it), then `[Claude] Provider initialized`, status becomes "Listening...".

- [ ] **Step 5: Typed message**

Type a message in the assistant view. Expected: streamed response appears; terminal logs `[Claude] Response completed`.

- [ ] **Step 6: Audio path**

Play some speech audio (e.g. a YouTube video). Expected: on pause in speech, terminal logs `[LocalAI] Transcription: ...`, then a Claude answer streams in. (With a Groq key set, the answer comes from Groq instead — logs `Sending to Groq`.)

- [ ] **Step 7: Screenshot path**

Trigger screen analysis (Cmd+Enter / next-step shortcut). Expected: `[Claude] Sending image to claude-opus-4-8 (streaming)...` and a streamed answer.

- [ ] **Step 8: Local mode regression**

Switch to "Use local AI" and (if Ollama is installed) start a local session; confirm it still transcribes and answers via Ollama. If Ollama isn't running, confirm the "Cannot connect to Ollama" error still appears — proving local mode wiring is intact.

- [ ] **Step 9: Close session**

Stop the session. Expected: no reconnect attempts, audio capture stops, no errors.
