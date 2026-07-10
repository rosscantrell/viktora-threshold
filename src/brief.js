// Threshold check-in brief (WP-CHECKIN-BRIEF, Ross UAT 2026-07-10; Trisha
// discovery 2026-07-10).
//
// The intermediate tier: a small drop-down from the widget answering "what do I
// need to look at right now" — WITHOUT opening the heavy Today surface. Trisha's
// ask, verbatim: dead simple — overdue / due today / rest of this week / coming
// up, "click and see." The morning / mid-day / evening tabs only re-weight
// emphasis (tagline + which buckets open) and, at mid-day, surface a "gone quiet"
// strip. Deterministic from the decision-log; "what got done" stays out (no
// completion timestamp yet), and the real "what am I missing" (inbound-with-no-
// response) is the engine North Star tracked separately.

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;

// ───────────────────────────────────────────────────────────────────────────
// Curation — the ONE place to tune the check-in. (Refine as Trisha's use firms.)
// ───────────────────────────────────────────────────────────────────────────
const SILENT_DAYS = 3;      // "no one's checked in on this" threshold (mid-day)
const ROWS_PER_SECTION = 10; // cap — she complained about endless scrolling

// The four buckets, always in this order. tone:"fire" spends the one amber accent.
const CORE_SECTIONS = [
  { key: "overdue", label: "Overdue", tone: "fire" },
  { key: "dueToday", label: "Due today", alwaysShow: true },
  { key: "restOfWeek", label: "Rest of this week" },
  { key: "comingUp", label: "Coming up" },
];

// Each time lens: tagline + which buckets open by default + an optional leading
// callout (mid-day's "gone quiet" is the buildable-now proxy for "what am I
// missing"). The buckets themselves never change — only emphasis (keep it simple).
const LENSES = {
  morning: { label: "Morning", tagline: "Here's your day", open: ["dueToday", "overdue"] },
  midday: {
    label: "Mid-day",
    tagline: "What's slipping — half the day's gone",
    open: ["dueToday", "overdue"],
    callout: { key: "silent", label: "Gone quiet", tone: "fire" },
  },
  evening: { label: "Evening", tagline: "Close out & tee up tomorrow", open: ["dueToday", "restOfWeek"] },
};

function currentLens(now) {
  const h = now.getHours();
  if (h < 12) return "morning";
  if (h < 17) return "midday";
  return "evening";
}

// ───────────────────────────────────────────────────────────────────────────
// Standup — run this check-in WITH the AI companion (WP-CHECKIN-STANDUP).
// Opens the configured AI surface (Settings → Integrations → AI companion,
// localStorage — same window, so the store is shared). The Apolla MCP standup
// prompt carries the ritual + the packet; the ?q= prefill is a claude.ai
// nicety, not the mechanism.
// ───────────────────────────────────────────────────────────────────────────
const COMPANION_URL_KEY = "threshold.companionUrl";
const COMPANION_DEFAULT_URL = "https://claude.ai/new";
const STANDUP = {
  morning: { label: "Standup", prompt: "Run my morning standup" },
  midday: { label: "Check-in", prompt: "Run my mid-day check-in" },
  evening: { label: "Debrief", prompt: "Run my end-of-day debrief" },
};
let _lens = null; // current lens; renderLens keeps it + the button label in sync

async function openStandup() {
  const st = STANDUP[_lens] || STANDUP.morning;
  let url = (localStorage.getItem(COMPANION_URL_KEY) || COMPANION_DEFAULT_URL).trim();
  if (/^https:\/\/(www\.)?claude\.ai\/new\/?$/.test(url)) {
    url += "?q=" + encodeURIComponent(st.prompt);
  }
  try {
    await invoke("plugin:opener|open_url", { url });
  } catch (e) {
    console.warn("[brief] standup open failed:", e);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Compute — bucket open commitments by calendar (mirrors the day digest).
// ───────────────────────────────────────────────────────────────────────────
function parseDue(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function prettySlug(slug) {
  if (!slug || typeof slug !== "string") return "";
  return slug.split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

function computeBuckets(records, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const dayMs = 86400000;
  const dow = today.getDay();
  const addToFri = dow === 0 ? 5 : dow === 6 ? 6 : 5 - dow;
  const weekEndMs = t0 + addToFri * dayMs + (dayMs - 1);
  const horizonMs = t0 + 14 * dayMs;

  const b = { overdue: [], dueToday: [], restOfWeek: [], comingUp: [], silent: [] };
  for (const it of Array.isArray(records) ? records : []) {
    const rec = (it && it.record) || {};
    if ((it.state || "open") !== "open") continue;
    if (rec.type && rec.type !== "commitment") continue;
    const d = parseDue((it && it.effectiveDue) || rec.due);
    if (!d) continue;
    const t = d.getTime();
    const readiness = it.readiness || rec.readiness || null;
    const wb = it.workbackShadow || rec.workbackShadow || null;
    const proj = wb && (wb.projection || wb);
    const atRisk = readiness === "no-precursor" || !!(proj && proj.fire === true) || it.noDraft === true;
    const lc = it.lifecycle || {};
    const silentDays = typeof lc.silentDays === "number" ? lc.silentDays : null;
    const e = { rec, d, t, atRisk, silentDays, owner: rec.owner || "", summary: (rec.summary || "").trim(), documentId: rec.documentId };

    if (t < t0) b.overdue.push(e);
    else if (t < t0 + dayMs) b.dueToday.push(e);
    else if (t <= weekEndMs) b.restOfWeek.push(e);
    else if (t <= horizonMs) b.comingUp.push(e);
    // "Gone quiet": open + no activity for SILENT_DAYS+, still on the clock
    // (overdue or due this work-week). The current-data proxy for "am I missing this".
    if (silentDays != null && silentDays >= SILENT_DAYS && t <= weekEndMs) b.silent.push(e);
  }
  // Overdue leads with the at-risk (on fire) ones; everything else soonest-first.
  b.overdue.sort((x, y) => (y.atRisk - x.atRisk) || (x.t - y.t));
  ["dueToday", "restOfWeek", "comingUp", "silent"].forEach((k) => b[k].sort((x, y) => x.t - y.t));
  b.overdueAtRiskN = b.overdue.filter((e) => e.atRisk).length;
  return b;
}

// ───────────────────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────────────────
function relDue(e, t0) {
  const days = Math.round((e.t - t0) / 86400000);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return e.d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderRow(e, t0) {
  const wrap = document.createElement("div");
  wrap.className = "brief-row";

  const row = document.createElement("div");
  row.className = "brief-item";
  const txt = document.createElement("span");
  txt.className = "brief-item-text";
  const full = (e.owner ? prettySlug(e.owner) + " · " : "") + (e.summary || "(no summary)");
  txt.textContent = full;
  txt.title = full;
  row.appendChild(txt);
  const due = document.createElement("span");
  due.className = "brief-item-due";
  due.textContent = relDue(e, t0);
  row.appendChild(due);
  wrap.appendChild(row);

  // Light inline expand (Ross UAT 2026-07-10): a row click opens a LITTLE detail
  // in place — the glance stays a glance; full Today is the explicit deeper hop.
  const detail = document.createElement("div");
  detail.className = "brief-detail";
  detail.hidden = true;
  let built = false;
  row.addEventListener("click", () => {
    if (!built) { buildDetail(detail, e); built = true; }
    detail.hidden = !detail.hidden;
    wrap.classList.toggle("open", !detail.hidden);
  });
  wrap.appendChild(detail);
  return wrap;
}

// The "little more" — untruncated summary + the verbatim promise + owner/due/status,
// and an explicit hop to the full item. Deliberately shallow (a few lines), not the
// whole record.
function buildDetail(box, e) {
  const rec = e.rec || {};
  if (e.summary) {
    const s = document.createElement("p");
    s.className = "brief-detail-summary";
    s.textContent = e.summary;
    box.appendChild(s);
  }
  if (rec.verbatim) {
    const q = document.createElement("p");
    q.className = "brief-detail-quote";
    q.textContent = "“" + rec.verbatim + "”";
    box.appendChild(q);
  }
  const meta = document.createElement("p");
  meta.className = "brief-detail-meta";
  const bits = [];
  if (e.owner) bits.push(prettySlug(e.owner));
  bits.push("due " + e.d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  if (e.atRisk) bits.push("at risk");
  else if (e.silentDays != null && e.silentDays >= SILENT_DAYS) bits.push("quiet " + e.silentDays + "d");
  const primary = rec.primaryEntity ? prettySlug(rec.primaryEntity) : "";
  if (primary) bits.push(primary);
  meta.textContent = bits.join(" · ");
  box.appendChild(meta);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "brief-detail-open";
  open.textContent = "Open in Today →";
  open.addEventListener("click", (ev) => { ev.stopPropagation(); openFull(); });
  box.appendChild(open);
}

function countText(key, items, buckets) {
  if (key === "overdue" && buckets.overdueAtRiskN) return `${items.length} · ${buckets.overdueAtRiskN} at risk`;
  return items.length ? String(items.length) : "";
}

function renderSection(host, sec, items, buckets, expanded, t0ms) {
  const wrap = document.createElement("div");
  wrap.className = "brief-section" + (sec.tone ? " tone-" + sec.tone : "");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "brief-section-head";
  head.setAttribute("aria-expanded", expanded ? "true" : "false");
  const caret = document.createElement("span");
  caret.className = "brief-caret";
  caret.textContent = expanded ? "▾" : "▸";
  const label = document.createElement("span");
  label.className = "brief-section-label";
  label.textContent = sec.label;
  const count = document.createElement("span");
  count.className = "brief-section-count";
  count.textContent = countText(sec.key, items, buckets);
  head.append(caret, label, count);
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "brief-items";
  body.hidden = !expanded;
  if (items.length) {
    items.slice(0, ROWS_PER_SECTION).forEach((e) => body.appendChild(renderRow(e, t0ms)));
    if (items.length > ROWS_PER_SECTION) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "brief-more";
      more.textContent = `+${items.length - ROWS_PER_SECTION} more — open in Today →`;
      more.addEventListener("click", openFull);
      body.appendChild(more);
    }
  } else {
    const em = document.createElement("div");
    em.className = "brief-empty";
    em.textContent = sec.key === "dueToday" ? "Nothing due today." : "Nothing here.";
    body.appendChild(em);
  }
  wrap.appendChild(body);
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    head.setAttribute("aria-expanded", body.hidden ? "false" : "true");
    caret.textContent = body.hidden ? "▸" : "▾";
  });
  host.appendChild(wrap);
}

function renderLens(lensKey, buckets, now) {
  const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
  const t0ms = t0.getTime();
  const lens = LENSES[lensKey];
  _lens = lensKey;
  document.getElementById("brief-standup-label").textContent = (STANDUP[lensKey] || STANDUP.morning).label;
  document.getElementById("brief-tagline").textContent = lens.tagline;
  for (const tab of document.querySelectorAll(".brief-tab")) {
    tab.setAttribute("aria-selected", tab.dataset.lens === lensKey ? "true" : "false");
  }
  const host = document.getElementById("brief-sections");
  host.innerHTML = "";

  // Leading callout (mid-day "gone quiet") — the "what am I missing" proxy, up top.
  if (lens.callout && buckets[lens.callout.key] && buckets[lens.callout.key].length) {
    renderSection(host, lens.callout, buckets[lens.callout.key], buckets, true, t0ms);
  }

  const openSet = new Set(lens.open || []);
  for (const sec of CORE_SECTIONS) {
    const items = buckets[sec.key] || [];
    if (!items.length && !sec.alwaysShow) continue; // hide empty buckets — keep it uncluttered
    renderSection(host, sec, items, buckets, openSet.has(sec.key), t0ms);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Data + lifecycle
// ───────────────────────────────────────────────────────────────────────────
let _buckets = null;

async function load() {
  const now = new Date();
  document.getElementById("brief-date").textContent =
    now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  try {
    const [dl, dismissed] = await Promise.all([
      invoke("fetch_decision_log_full"),
      invoke("get_dismissed_record_ids").catch(() => []),
    ]);
    const dropped = new Set(Array.isArray(dismissed) ? dismissed : []);
    const records = (Array.isArray(dl && dl.records) ? dl.records : [])
      .filter((it) => !dropped.has(((it && it.record) || {}).recordId));
    _buckets = computeBuckets(records, now);
    document.getElementById("brief-status").hidden = true;
    renderLens(currentLens(now), _buckets, now);
  } catch (err) {
    console.warn("[brief] load failed:", err);
    document.getElementById("brief-status").textContent =
      "Couldn't reach Apolla — try again from the widget.";
  }
}

async function openFull() {
  try { await invoke("widget_expand", { targetTab: null }); } catch (e) { console.warn("[brief] open full:", e); }
}

document.getElementById("brief-tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest(".brief-tab");
  if (!tab || !_buckets) return;
  renderLens(tab.dataset.lens, _buckets, new Date());
});

document.getElementById("brief-collapse").addEventListener("click", async () => {
  // Reuse the widget collapse — the brief is a floating panel (never fullscreen),
  // so perform_widget_collapse just shrinks it back to the pill + restores position.
  try { await invoke("widget_collapse"); } catch (e) { console.warn("[brief] collapse:", e); }
});

document.getElementById("brief-open-full").addEventListener("click", openFull);

document.getElementById("brief-standup").addEventListener("click", openStandup);

load();
