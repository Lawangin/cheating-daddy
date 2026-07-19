# Replace Gemini API key with Claude (Anthropic) API key — Design

Date: 2026-07-19
Status: Approved

## Goal

In BYOK mode, the user enters a single **Claude (Anthropic) API key** instead of a
Gemini key. All Gemini usage is removed. Audio transcription moves to the local
Whisper pipeline that local mode already uses; Claude handles all LLM responses
(chat, transcription answers, screenshot analysis). The optional Groq key keeps its
current behavior. Local mode and the (UI-disabled) cloud mode are unchanged.

## Current architecture (BYOK)

- `src/utils/gemini.js` opens a Gemini Live session (`gemini-3.1-flash-live-preview`)
  used only for **streaming input transcription with speaker diarization**.
  SystemAudioDump feeds it 24kHz PCM chunks.
- On `generationComplete`, the accumulated transcription is answered by
  `sendToGroq()` (if a Groq key exists) or `sendToGemma()` (Gemini key,
  `gemma-4-26b-a4b-it`).
- Screenshots go to `sendImageToGeminiHttp()` (Gemini vision models rotated by
  `getAvailableModel()` rate-limit bookkeeping in `storage.js`).
- Local mode (`src/utils/localai.js`) has a parallel pipeline:
  audio → resample 24k→16k → VAD → Whisper (`@huggingface/transformers`) →
  `sendToOllama()`.

## Target architecture (BYOK)

```
SystemAudioDump ─► VAD + Whisper (shared with local mode)
                        │ transcription text
                        ▼
             Groq key set? ── yes ──► sendToGroq()  (unchanged)
                        │ no
                        ▼
                  sendToClaude()  ── streaming ──► renderer
Screenshots  ─►  sendImageToClaude()  ── streaming ──► renderer
Typed text   ─►  sendToClaude()
```

## Components

### 1. New: `src/utils/claude.js`

Uses `@anthropic-ai/sdk` (official SDK; new dependency). Model: `claude-opus-4-8`.

- `sendToClaude(transcription)` — mirrors `sendToGemma()`: maintains a rolling
  conversation history (last 20 turns), system prompt from `getSystemPrompt()`,
  streams via `client.messages.stream()`, emits `new-response` / `update-response`
  to the renderer, saves the turn with `saveConversationTurn()`.
- `sendImageToClaude(base64Jpeg, prompt)` — mirrors `sendImageToGeminiHttp()`:
  vision request (base64 image block + text), streaming, saves screen analysis
  history. Returns `{ success, text, model }`.
- Web search: when the app's enabled-tools include `googleSearch`, requests include
  Claude's server-side web search tool (`{type: "web_search_20260209", name: "web_search"}`).
- `max_tokens` ~1024 for realtime answers (matches Groq path); streaming used for
  all calls. Errors surface via `update-status` like existing paths.

### 2. `src/utils/localai.js` — configurable transcription sink

`handleSpeechEnd()` currently hard-codes `sendToOllama(transcription)`. Add a
module-level sink callback set at session init:

- `initializeLocalSession(...)` — sets sink to Ollama (unchanged behavior).
- New `initializeByokAudioSession(whisperModel, profile, customPrompt)` — loads
  Whisper, resets VAD state, sets sink to the BYOK answerer (Groq if key, else
  Claude). No Ollama connection is made or required in BYOK mode.

### 3. `src/utils/gemini.js` — remove Gemini, rewire BYOK

- Delete: `initializeGeminiSession`, `attemptReconnect`, `sendAudioToGemini`,
  `sendToGemma`, `sendImageToGeminiHttp`, the `@google/genai` import.
- `initialize-gemini` IPC channel **keeps its name** (renderer contract unchanged)
  but now: stores the Claude key context, calls
  `initializeByokAudioSession(whisperModel, profile, customPrompt)`.
- BYOK audio chunks route to `processLocalAudio()` (same as local mode) instead of
  the live session.
- Text message handler: BYOK branch calls Groq (if key) else `sendToClaude()`;
  drops the `sendRealtimeInput` mirror call.
- Screenshot handler: BYOK branch calls `sendImageToClaude()`.
- Reconnect machinery is deleted (no persistent upstream connection exists anymore;
  Whisper is local and Claude calls are per-request).

### 4. UI — `src/components/views/MainView.js`

- BYOK form: "Gemini API Key" → "Claude API Key"; hint link →
  Anthropic Console API keys page. Placeholder/validation unchanged
  (required, `_keyError` logic as-is).
- Whisper model selector (currently local-mode-only) is also shown in BYOK mode,
  since BYOK now transcribes with Whisper.
- Groq field unchanged. Local mode UI unchanged.

### 5. Storage — `src/storage.js`

- The `apiKey` credential slot now holds the Anthropic key. Field name is kept
  (no migration needed); labels/comments updated. `getApiKey()`/`setApiKey()`
  unchanged.
- Gemini rate-limit bookkeeping (`getAvailableModel`, `incrementLimitCount`, the
  Gemini model rotation tables) is removed if nothing else references it; Groq
  bookkeeping (`getModelForToday`, `incrementCharUsage`) stays.

### 6. Dependencies

- Add `@anthropic-ai/sdk`.
- Remove `@google/genai` if no remaining references (cloud.js uses the app's own
  backend token, not Gemini — verify before removal).

## Error handling

- Missing key: same behavior as today (`No API key configured` result / key error
  state in UI).
- Claude API errors: caught per-call; typed SDK errors reported through
  `update-status` (e.g. rate limit vs auth), never crash the session.
- Whisper load failure in BYOK: session init returns false, matching local mode.

## Known trade-offs

- **Speaker diarization is lost** ("[Interviewer]/[Candidate]" labels) — Whisper
  does not diarize. Same limitation local mode already has. `formatSpeakerResults`
  becomes dead code for BYOK and is removed with the live session.
- Gemini's proactive-audio behavior is replaced by VAD end-of-speech detection —
  answers now trigger when the speaker pauses.
- The `language` UI setting no longer maps to a live-session language code;
  Whisper auto-detects language.

## Testing

- Manual: BYOK start with a Claude key → speak (or play audio) → transcription →
  Claude answer streams into the assistant view; screenshot analysis works; typed
  messages work; Groq-key-present path still answers via Groq.
- Local mode regression check: unchanged behavior (Ollama + Whisper).
- No automated test framework exists in this repo; verification is manual via
  `pnpm start`.
