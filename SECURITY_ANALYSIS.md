# Security Analysis: "cheating-daddy" Screen-Capture Overlay

**Purpose of this document:** defensive analysis. It explains how this class of
tool hides an overlay from screen recording, *why that hiding is not actually
"undetectable,"* and what a proctoring / conferencing / assessment platform can
do to detect and mitigate it. It is written for the defender's side of the
problem (detection engineering), not to improve the tool's evasion.

> **Scope note.** This report deliberately does **not** provide a plan to make
> the tool evade detection on CodeSignal, Zoom, or Google Meet. Those are live
> hiring-assessment and meeting platforms, and hardening an overlay to defeat
> their integrity controls is cheating/fraud, not research. Everything below is
> framed so a defender can *catch* the tool. The detection sections inherently
> reveal the tool's weaknesses — that is the point.

---

## 1. What the tool actually is

An Electron desktop app (`cheating-daddy`, v0.7.0) that:

- Captures the screen (`navigator.mediaDevices.getDisplayMedia`, `desktopCapturer`) on a timer (default every 5 s, `renderer.js:198`) and captures system audio (`SystemAudioDump` native helper on macOS, loopback elsewhere).
- Streams those frames + audio to an LLM (Google Gemini Live, or a local/Ollama model) with interview-oriented prompts.
- Renders the model's answers in a **frameless, transparent, always-on-top overlay window** the user reads while on a call or in an assessment.

The "not captured by screen recording" property is the only genuinely interesting security claim, and it comes from **one line**.

---

## 2. How the "invisible to recording" trick works

### 2.1 The core mechanism

```js
// src/utils/window.js
mainWindow.setContentProtection(true);
```

`setContentProtection(true)` is a standard Electron API that maps to the OS-level
"exclude from capture" flag:

| OS | Underlying API | Effect |
|----|----------------|--------|
| Windows | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` | The DWM compositor omits the window from the frame buffer handed to screen-capture APIs. The window is visible on the physical monitor but blank/absent in captures. |
| macOS | `NSWindow.sharingType = .none` | The window is excluded from `CGWindowListCreateImage` / `SCStream` shared surfaces. |

This is the *same* API legitimate apps use to protect DRM video and password
managers. That is why it works against **naive** capture: Zoom/Meet/OBS ask the
OS for the screen, and the OS honors the exclusion flag by handing back a frame
buffer that never contained the window.

### 2.2 The supporting stealth flags (all in `window.js`)

- `frame: false`, `transparent: true`, `hasShadow: false`, `backgroundColor: '#00000000'` — no window chrome to notice.
- `setSkipTaskbar(true)` (Windows) / `setHiddenInMissionControl(true)` (macOS) — hidden from taskbar & Mission Control.
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` — follows the user across desktops and over fullscreen apps.
- `setAlwaysOnTop(true, 'screen-saver', 1)` — stacks above almost everything.
- `Cmd/Ctrl+\` instantly hides; `Cmd/Ctrl+Shift+E` "emergency erase" hides, kills the AI session, wipes sensitive data, and quits.

### 2.3 What this means

The tool is invisible to **the video that leaves the machine**. It is *not*
invisible to **the machine itself**. Everything below exploits that gap. The
central defensive fact: `WDA_EXCLUDEFROMCAPTURE` hides pixels from the compositor's
capture path, but it changes nothing about the process, window, GPU, network, or
input layers — all of which a defender can inspect.

---

## 3. Honest verdict: is it "truly undetectable"?

**No.** It defeats *passive pixel capture only*. Against any endpoint-side or
behavior-side integrity control it is quite detectable. Reasons:

1. **The exclusion flag is itself a signal.** An app can enumerate top-level windows and query `GetWindowDisplayAffinity`. A window that returns `WDA_EXCLUDEFROMCAPTURE` while not being a known DRM/password app is *itself* the tell. The very trick that hides it is queryable.
2. **The process is loud.** Product name literally "Cheating Daddy," a bundled `SystemAudioDump` helper, an Electron process holding a persistent WebSocket to `generativelanguage.googleapis.com`. Trivial to fingerprint.
3. **It captures the screen.** On macOS it must hold a Screen Recording TCC permission and appears in the purple-dot / control-center capture indicator. `getDisplayMedia` shows the OS "you are sharing your screen" affordance unless suppressed.
4. **It is behaviorally obvious.** A candidate reading answers off an invisible overlay shows gaze drift, unnatural pauses, and pasted/rhythmically-typed optimal solutions.
5. **No anti-analysis whatsoever.** `contextIsolation: false`, `nodeIntegration: true`, plaintext local storage, no obfuscation, no process-name randomization, an unsigned/un-notarized build. From an endpoint-agent perspective it is wide open.

So: robust against a friend recording their screen in Zoom; weak against any
platform that runs an integrity/proctoring agent or does gaze/behavior analysis.

---

## 4. Detection surface (this is the defensive core)

Ordered from most robust/portable to most brittle. A real proctoring stack layers
several so that defeating one is not enough.

### 4.1 Window-affinity enumeration (highest signal)
- **Windows:** enumerate top-level windows (`EnumWindows`), call `GetWindowDisplayAffinity` on each. Flag any window with `WDA_EXCLUDEFROMCAPTURE`/`WDA_MONITOR` that is not on an allowlist of known DRM/password-manager apps.
- **macOS:** enumerate windows via `CGWindowListCopyWindowInfo`; cross-reference the on-screen window list against what a `SCStream` capture actually contains. A window that is present to the window server but *absent from the capturable set* is the exact signature of `sharingType = .none`.
- **Why it's strong:** it keys on the evasion mechanism itself, not on a name string, so renaming the app does not help.

### 4.2 Process / binary fingerprinting
- Enumerate running processes and loaded modules for: Electron apps holding screen-capture handles, the `SystemAudioDump` helper (unique, bundled, `pkill`-managed at `gemini.js:621`), and known hashes of released builds.
- Network egress: a persistent WebSocket to `generativelanguage.googleapis.com` (or Ollama on `localhost:11434`) correlated in time with the assessment window.
- **Weakness of the target:** the app ships an unsigned build with a fixed product name and a distinctive helper binary — cheap to hash-match and cheap to name-match.

### 4.3 OS capture indicators & permission state
- **macOS:** Screen Recording requires a TCC grant; while active, the OS shows the capture indicator and lists the app in Control Center. A proctor can require that indicator be *off*, or enumerate TCC grants.
- **Windows:** the app calling `getDisplayMedia` is subject to the OS capture/share prompts and indicators.

### 4.4 GPU/compositor cross-check
- Compare a compositor-level capture (honors the exclusion flag) against an independent capture path — e.g. a hardware-level or DDA capture, or comparing reported window geometry vs. captured pixels. Regions that are occupied in the window tree but blank in the compositor capture betray an excluded window.

### 4.5 Behavioral / proctoring signals (platform-side, no endpoint agent needed)
- **Gaze & head pose:** eyes repeatedly tracking to a fixed off-editor region; reading cadence.
- **Focus/visibility events:** `document.visibilitychange`, `window.blur`, pointer leaving the assessment surface, full-screen exits.
- **Answer forensics:** paste events, inter-keystroke timing that looks transcribed rather than composed, sudden jumps to optimal solutions, code style inconsistent with the candidate's earlier work.
- **Timing correlation:** pauses that line up with the 5 s screenshot cadence + model round-trip latency.

### 4.6 Second-camera / out-of-band (defeats *all* on-screen hiding)
- A required phone/side camera or room scan sees the physical monitor, where the overlay **is** visible (the exclusion flag only affects captures, not the panel's photons). This is why serious in-person or high-stakes remote assessments use it: it sidesteps the entire endpoint arms race.

---

## 5. Mitigations for a defender (platform / proctoring vendor)

| Layer | Mitigation | Defeats |
|-------|------------|---------|
| Endpoint agent | Enumerate windows + `GetWindowDisplayAffinity` / macOS window-vs-capture diff; alert on non-allowlisted excluded windows | §2 core trick directly |
| Endpoint agent | Process/module/network fingerprinting + known-hash matching | Bundled build, helper binary, LLM egress |
| OS policy | Require capture indicator off; read TCC / capture-permission state | macOS screen-recording grant |
| Assessment client | Track focus/visibility/paste/gaze; full-screen lock; blur detection | Behavioral use of the overlay |
| Process integrity | Second camera / room scan / in-person for high-stakes | **Every** on-screen concealment method |
| Assessment design | Interactive, discussion-based, follow-up "explain your code" rounds | AI-assisted answers regardless of tooling |

The load-bearing insight for defenders: **on-screen invisibility is not
answer-invisibility.** Every control in the bottom half of that table ignores the
overlay entirely and evaluates the human. Those are the durable defenses; the
endpoint-agent rows are an arms race, the assessment-design rows are not.

---

## 6. Notable weaknesses in *this specific* implementation (defender's cheat-sheet)

These make this build especially easy to catch — useful for writing detections:

- **Fixed identifiers:** product name "Cheating Daddy," window title, and the `SystemAudioDump` helper are all static strings/binaries → signature-matchable.
- **`contextIsolation: false` + `nodeIntegration: true`** (`window.js`) — no sandboxing; an endpoint agent (or a hostile page) faces a wide attack surface, and the app itself is trivial to introspect.
- **Unsigned / un-notarized** (`forge.config.js` signing is commented out) → no stable code-signature to launder reputation; Gatekeeper/SmartScreen friction; easy allow/deny-listing by absence of signature.
- **Deterministic capture cadence** (5 s) → timing side-channel.
- **Plaintext local storage** of API keys and session history (`storage.js`) → not a detection vector per se, but confirms zero anti-forensics.
- **Distinct network signature** → persistent Gemini Live WebSocket correlates with assessment timing.

---

## 7. Suggested defensive follow-up work

These are **detection-side** tasks (build the catcher), suitable to hand to
separate agents/engineers. None of them harden the tool.

1. **Window-affinity scanner (Windows).** Prototype an `EnumWindows` +
   `GetWindowDisplayAffinity` sweep that lists windows reporting
   `WDA_EXCLUDEFROMCAPTURE` and diffs against a DRM/password-manager allowlist.
   Deliverable: PoC + false-positive analysis against common legit apps
   (Netflix/Edge DRM, 1Password, banking apps).

2. **macOS window-vs-capture differ.** Compare `CGWindowListCopyWindowInfo`
   against the window set actually present in an `SCStream` capture; flag windows
   present to the window server but absent from capture. Deliverable: PoC +
   indicator-of-compromise notes.

3. **Process/network fingerprint set.** Catalog stable signals for this tool
   class (Electron + screen-capture handle + LLM-endpoint WebSocket + audio
   helper). Deliverable: a detection rule (e.g. Sigma/EDR-style) with tuning
   guidance.

4. **Behavioral-signal spec for assessment clients.** Define the focus/visibility/
   paste/gaze/timing telemetry an assessment surface should collect and the
   scoring that flags overlay-assisted sessions. Deliverable: an event schema +
   heuristics doc.

5. **Defender's test harness (own machines only).** Stand up a controlled lab —
   your own accounts, your own recorder, no third-party assessment platform — to
   validate that detections #1–#4 fire on this build and don't fire on clean
   baselines. Deliverable: repeatable test matrix + results.

> Task #5 is scoped to your own infrastructure precisely because validating
> *detections* is legitimate, while validating *evasion against a live
> third-party assessment platform* is not. Keep the harness pointed at your own
> recorder, not at CodeSignal/Zoom/Meet integrity systems.

---

## 8. Bottom line

- The "OS-level invisibility" is one Electron call (`setContentProtection(true)`) plus window-hiding flags. It defeats **passive pixel capture only**.
- It is **not** "truly undetectable." The exclusion flag is itself queryable, the process/network/permission footprint is loud, and the human behavior it enables is observable.
- The durable defenses don't fight the overlay at all — they authenticate the human (behavioral proctoring, second camera, interactive assessment). Endpoint window-affinity enumeration is the single highest-signal *technical* detection because it keys on the evasion mechanism itself.
