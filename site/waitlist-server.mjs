#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Threshold beta waitlist service — tiny, self-contained.
//
// POST /api/waitlist  { name, email, role, company? }
//   → appends a JSONL record to WAITLIST_DATA_FILE
//   → sends a notification email via Resend (when EMAIL_API_KEY is set;
//     otherwise console-logs the notification so nothing is lost)
//   → 429 per-IP rate limit (in-memory token bucket)
//   → strict CORS: only viktora.ai origins
//   → honeypot: a filled `company` field ⇒ accepted-and-dropped (bot)
//
// Dependencies: node stdlib only. Resend is called over plain HTTPS (fetch),
// so there is nothing to `npm install`. Run behind nginx (see DEPLOY.md).
//
// Env:
//   WAITLIST_PORT        listen port           (default 4770)
//   WAITLIST_DATA_FILE   JSONL sink            (default ./waitlist.jsonl)
//   EMAIL_API_KEY        Resend API key        (optional; console fallback)
//   WAITLIST_NOTIFY_TO   notification recipient (default beta@viktora.ai)
//   WAITLIST_FROM        Resend "from" address  (default "Threshold <beta@viktora.ai>")
//   WAITLIST_ALLOW_ORIGINS  comma list override (default the viktora.ai set)
// ─────────────────────────────────────────────────────────────────────────

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.WAITLIST_PORT || 4770);
const DATA_FILE =
  process.env.WAITLIST_DATA_FILE || path.join(__dirname, "waitlist.jsonl");
const EMAIL_API_KEY = process.env.EMAIL_API_KEY || "";
const NOTIFY_TO = process.env.WAITLIST_NOTIFY_TO || "beta@viktora.ai";
const FROM = process.env.WAITLIST_FROM || "Threshold <beta@viktora.ai>";

// Strict allow-list — only the marketing origins. Localhost is included for
// dev; drop WAITLIST_ALLOW_ORIGINS in prod to pin it exactly.
const ALLOW_ORIGINS = (
  process.env.WAITLIST_ALLOW_ORIGINS ||
  "https://viktora.ai,https://www.viktora.ai"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Rate limiting: simple in-memory token bucket per IP ──────────────────
const RATE_MAX = Number(process.env.WAITLIST_RATE_MAX || 5); // requests
const RATE_WINDOW_MS = Number(process.env.WAITLIST_RATE_WINDOW_MS || 60_000); // per minute
const buckets = new Map(); // ip → { count, resetAt }

function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(ip, b);
  }
  b.count += 1;
  return b.count > RATE_MAX;
}
// Opportunistic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now >= b.resetAt) buckets.delete(ip);
}, RATE_WINDOW_MS).unref();

// ── Helpers ──────────────────────────────────────────────────────────────
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function corsHeaders(origin) {
  const h = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
  if (origin && ALLOW_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function send(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitize(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, max);
}

// ── Resend notification (best-effort; never blocks the 200) ──────────────
async function notify(entry) {
  const lines = [
    `New Threshold beta signup`,
    ``,
    `Name:  ${entry.name}`,
    `Email: ${entry.email}`,
    `Runs:  ${entry.role || "(not given)"}`,
    `IP:    ${entry.ip}`,
    `When:  ${entry.ts}`,
  ].join("\n");

  if (!EMAIL_API_KEY) {
    // Console fallback — the record is already persisted to JSONL, so this is
    // purely the human ping. Visible in pm2 logs.
    console.log("[waitlist] (no EMAIL_API_KEY) notification:\n" + lines);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [NOTIFY_TO],
        subject: `Beta signup — ${entry.name}`,
        text: lines,
        reply_to: entry.email,
      }),
    });
    if (!res.ok) {
      console.error(
        `[waitlist] Resend HTTP ${res.status}: ${await res.text()}`,
      );
    }
  } catch (err) {
    console.error("[waitlist] Resend error:", err && err.message);
  }
}

// ── Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // Health
  if (req.method === "GET" && (req.url === "/health" || req.url === "/api/waitlist/health")) {
    send(res, 200, { status: "ok" }, cors);
    return;
  }

  if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/api/waitlist") {
    send(res, 404, { error: "not found" }, cors);
    return;
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    send(res, 429, { error: "rate limited — try again shortly" }, {
      ...cors,
      "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)),
    });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch {
    send(res, 413, { error: "payload too large" }, cors);
    return;
  }

  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    // Fall back to urlencoded (no-JS plain form POST).
    try {
      const params = new URLSearchParams(raw);
      data = Object.fromEntries(params.entries());
    } catch {
      send(res, 400, { error: "bad request" }, cors);
      return;
    }
  }

  // Honeypot — a filled company field means a bot. Accept and drop silently
  // so the bot sees success and doesn't retry.
  if (sanitize(data.company, 200)) {
    send(res, 200, { ok: true }, cors);
    return;
  }

  const name = sanitize(data.name, 120);
  const email = sanitize(data.email, 200);
  const role = sanitize(data.role, 300);

  if (!name || !email || !EMAIL_RE.test(email)) {
    send(res, 422, { error: "name and a valid work email are required" }, cors);
    return;
  }

  const entry = {
    name,
    email,
    role,
    ip,
    ts: new Date().toISOString(),
    ua: sanitize(req.headers["user-agent"], 300),
    origin: origin || null,
  };

  try {
    fs.appendFileSync(DATA_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("[waitlist] append failed:", err && err.message);
    send(res, 500, { error: "could not record signup" }, cors);
    return;
  }

  // Fire-and-forget the notification — the signup is already durable.
  notify(entry);

  send(res, 200, { ok: true }, cors);
});

server.listen(PORT, () => {
  console.log(`[waitlist] listening on http://127.0.0.1:${PORT}`);
  console.log(`[waitlist] data file: ${DATA_FILE}`);
  console.log(
    `[waitlist] email: ${EMAIL_API_KEY ? "Resend enabled" : "console fallback (no EMAIL_API_KEY)"}`,
  );
  console.log(`[waitlist] allow-origins: ${ALLOW_ORIGINS.join(", ")}`);
});
