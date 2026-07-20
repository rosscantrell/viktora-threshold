// WP-VOICE-THRESHOLD-ENTRY V1 — call pill logic.
//
// Flow: mint a conversation credential via the voice_mint_session IPC (the
// Rust side carries the app's existing bearer; nothing secret lives in this
// page), then start the ElevenLabs session with the vendored client. WebRTC
// first; on a WebRTC start failure, re-mint for the signed-URL WebSocket
// fallback. Every failure path lands a plain reason in the pill (house law:
// fail closed but VISIBLE — never a silent dead window).
import { Conversation } from "./assets/vendor/elevenlabs-client.mjs";

const tauri = window.__TAURI__;

const dotEl = document.getElementById("dot");
const stateEl = document.getElementById("state");
const subEl = document.getElementById("sub");
const muteBtn = document.getElementById("btn-mute");
const hangupBtn = document.getElementById("btn-hangup");

let conversation = null;
let muted = false;
let ended = false;

// Stage timings for the RUBRIC grading row (read via console / __callTimings).
const t0 = performance.now();
const timings = { openedAt: new Date().toISOString() };
window.__callTimings = timings;
const mark = (k) => {
  timings[k] = Math.round(performance.now() - t0);
  console.log(`[call] ${k} +${timings[k]}ms`);
};

function setState(cls, label, sub) {
  dotEl.className = `state-dot ${cls}`;
  stateEl.textContent = label;
  subEl.textContent = sub || "";
}

function fail(reason) {
  ended = true;
  setState("error", "Couldn't start the call", reason);
  muteBtn.disabled = true;
  hangupBtn.textContent = "Close";
}

async function closeWindow() {
  try {
    await tauri.window.getCurrentWindow().close();
  } catch (e) {
    console.warn("[call] window close failed", e);
  }
}

function onDisconnect(details) {
  if (ended) return;
  ended = true;
  muteBtn.disabled = true;
  hangupBtn.textContent = "Close";
  hangupBtn.disabled = false;
  if (details && details.reason === "error") {
    setState("error", "Call dropped", details.message || "Connection error.");
  } else {
    setState("ended", "Call ended", "Your check-in is being filed.");
    // Give the ended state a beat to be seen, then get out of the way.
    setTimeout(closeWindow, 1800);
  }
}

const callbacks = {
  onConnect: ({ conversationId }) => {
    mark("connectedMs");
    console.log(`[call] conversation ${conversationId}`);
    muteBtn.disabled = false;
    setState("listening", "Listening", "");
  },
  onModeChange: ({ mode }) => {
    if (ended) return;
    // mode is "speaking" (agent talking) or "listening" (your turn).
    if (mode === "speaking") setState("speaking", "Speaking", "");
    else setState("listening", "Listening", "");
  },
  onStatusChange: ({ status }) => {
    if (ended) return;
    if (status === "connecting") setState("connecting", "Connecting…", "macOS will ask for microphone access.");
  },
  onError: (message, context) => {
    console.error("[call] session error:", message, context);
  },
  onDisconnect,
};

async function mint(transport) {
  const args = transport === "ws" ? { transport: "ws" } : {};
  return await tauri.core.invoke("voice_mint_session", args);
}

async function start() {
  setState("connecting", "Connecting…", "macOS will ask for microphone access.");
  let credential;
  try {
    credential = await mint("webrtc");
    mark("mintedMs");
  } catch (e) {
    return fail(String(e));
  }
  try {
    conversation = await Conversation.startSession({
      conversationToken: credential.conversationToken,
      connectionType: "webrtc",
      userId: credential.sessionId,
      ...callbacks,
    });
    mark("sessionStartedMs");
    timings.transport = "webrtc";
    return;
  } catch (e) {
    console.warn("[call] WebRTC start failed, trying WebSocket fallback:", e);
  }
  // WebSocket fallback — a fresh credential (the WebRTC token is single-use).
  try {
    const wsCredential = await mint("ws");
    conversation = await Conversation.startSession({
      signedUrl: wsCredential.signedUrl,
      connectionType: "websocket",
      userId: wsCredential.sessionId,
      ...callbacks,
    });
    mark("sessionStartedMs");
    timings.transport = "websocket";
  } catch (e) {
    fail(`Voice connection failed on both transports. ${String(e && e.message ? e.message : e)}`);
  }
}

muteBtn.addEventListener("click", () => {
  if (!conversation || ended) return;
  muted = !muted;
  conversation.setMicMuted(muted);
  muteBtn.textContent = muted ? "Unmute" : "Mute";
  muteBtn.classList.toggle("muted-on", muted);
});

hangupBtn.addEventListener("click", async () => {
  if (ended) return void closeWindow();
  hangupBtn.disabled = true;
  setState("ended", "Hanging up…", "");
  try {
    if (conversation) await conversation.endSession();
    else ended = true;
  } catch (e) {
    console.warn("[call] endSession failed", e);
    ended = true;
  }
  // onDisconnect paints "Call ended" + auto-closes; cover the no-session case.
  if (!conversation) closeWindow();
});

start();
