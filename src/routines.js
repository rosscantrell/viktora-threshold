// ── Daily routines — shared definitions (WP-CHECKIN-ROUTINES) ───────────────
//
// One module owns the identity of the four daily companion routines so the
// three consumers can never drift: the Settings card (main.js) edits times
// and toggles, the always-resident widget (widget.js) fires the native
// check-in pings, and the check-in brief's ✦ chip (brief.js) opens the
// companion with the routine's prompt.
//
// Architecture (2026-07-12 ruling): unattended runs are scheduled ENGINE-side
// (headless prework runner — no client involved); attended check-ins are
// NATIVE Threshold notifications at the user's times, whose reliable click
// path is the brief + ✦ chip. claude.ai scheduled tasks remain an optional
// cloud tier (one prefilled message; the user reviews and sends).
//
// The prompts stay deliberately thin — all protocol engineering is
// server-side in get_checkin_packet — and carry tz_offset_minutes computed
// from this machine's clock (packet convention: minutes east of UTC, the
// reverse sign of getTimezoneOffset), never hardcoded.

export const ROUTINES_KEY = "threshold.routines";

export const ROUTINES = [
  {
    key: "prework",
    name: "Pre-work session",
    desc: "unattended — your workspace stages drafts before you start",
    defaultTime: "07:00",
    attended: false,
    prompt: (tz) =>
      "Run my pre-work session: call get_checkin_packet with mode:'prework' and tz_offset_minutes:" +
      tz +
      ", follow its protocol exactly — investigate each candidate via the navigation recipe, " +
      "prepare drafts where preparable, classify PREPARED / PREPARABLE-BUT-BLOCKED / NOT-MINE — " +
      "then stage everything via stage_prework and stop. Do not capture, do not mark_seen, " +
      "do not message anyone.",
  },
  {
    key: "morning",
    name: "Morning standup",
    desc: "leads with the staged pre-work",
    defaultTime: "08:30",
    attended: true,
    defaultDoor: "companion",
    ping: { title: "Morning standup", body: "Your standup is ready — open the brief to start." },
    prompt: (tz) =>
      "Run my morning standup: call get_checkin_packet with tz_offset_minutes:" +
      tz +
      " and follow its protocol. Lead with the staged pre-work drafts, reconcile todaysPlan, " +
      "surface the incoming/watching/intake sections before plan work. We'll divide the work; " +
      "at close, capture the session per the protocol's session-close step — the agreed plan " +
      "and both our commitments mint from that capture.",
  },
  {
    key: "midday",
    name: "Midday check-in",
    desc: "short — what moved since morning",
    defaultTime: "12:30",
    attended: true,
    defaultDoor: "today",
    ping: { title: "Midday check-in", body: "What's moved, what's slipping — a short reconcile." },
    prompt: (tz) =>
      "Run my midday check-in: get_checkin_packet with tz_offset_minutes:" +
      tz +
      ", follow its protocol. Reconcile todaysPlan against what moved since morning; lead with " +
      "anything new/incoming since we last spoke. Max 3 decision points. Capture at close.",
  },
  {
    key: "evening",
    name: "Evening debrief",
    desc: "closes the day, seeds tomorrow",
    defaultTime: "17:30",
    attended: true,
    defaultDoor: "companion",
    ping: { title: "Evening debrief", body: "Close out the day and tee up tomorrow." },
    prompt: (tz) =>
      "Run my evening debrief: get_checkin_packet with tz_offset_minutes:" +
      tz +
      ", follow its protocol. Reconcile the day against todaysPlan — what closed " +
      "(propose_record_edit for anything I confirm done), what carries forward, what you'll " +
      "queue via propose_to_outbox for my morning send. Capture at close; that capture is " +
      "tomorrow's plan seed.",
  },
];

/** Packet convention: minutes east of UTC (EDT ⇒ -240). */
export function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/**
 * Per-routine config, defaults merged in: { key: { time: "HH:MM",
 * enabled: bool, door: "companion"|"today" } }. `enabled` and `door` only
 * mean anything for attended routines (the ping and where engaging the
 * routine lands); prework's schedule is engine-side and has no door.
 */
export function loadRoutines() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(ROUTINES_KEY)) || {};
  } catch (_e) { /* corrupt store ⇒ defaults */ }
  const cfg = {};
  for (const r of ROUTINES) {
    const s = saved[r.key] || {};
    cfg[r.key] = {
      time: /^\d{2}:\d{2}$/.test(s.time) ? s.time : r.defaultTime,
      enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    };
    if (r.attended) {
      cfg[r.key].door =
        s.door === "companion" || s.door === "today" ? s.door : r.defaultDoor;
    }
  }
  return cfg;
}

export function saveRoutines(cfg) {
  localStorage.setItem(ROUTINES_KEY, JSON.stringify(cfg));
}

/** "HH:MM" → minutes since local midnight; null when malformed. */
export function timeToMinutes(t) {
  const m = /^(\d{2}):(\d{2})$/.exec(t || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The optional cloud tier: ONE message asking Claude to create all four as
 * claude.ai scheduled tasks. The user reviews and sends it there — Threshold
 * never creates standing automation silently and cannot read the companion's
 * schedule back.
 */
export function composeRoutineSetupMessage(cfg) {
  const tz = tzOffsetMinutes();
  const abs = Math.abs(tz);
  const utc =
    "UTC" +
    (tz < 0 ? "-" : "+") +
    String(Math.floor(abs / 60)).padStart(2, "0") +
    ":" +
    String(abs % 60).padStart(2, "0");
  const lines = [
    "Set up my four daily Threshold check-in routines as scheduled tasks — all four from " +
      "this one message. (I can still edit the times below before sending this.)",
    "",
    "My timezone is " + utc + "; the times below are local, every weekday (Mon–Fri). The " +
      "tz_offset_minutes values in the prompts are already computed for my clock.",
    "",
  ];
  ROUTINES.forEach((r, i) => {
    const time = (cfg[r.key] && cfg[r.key].time) || r.defaultTime;
    lines.push(i + 1 + ". " + r.name + " — " + time + ". Task prompt:");
    lines.push('"' + r.prompt(tz) + '"');
    lines.push("");
  });
  lines.push("Create all four now, then list back exactly what you created with each schedule.");
  return lines.join("\n");
}
