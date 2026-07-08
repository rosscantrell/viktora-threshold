#!/usr/bin/env node
// Capture script for the Viktora Threshold user guide (v0.10).
//
// Drives the shim-harness (Tauri frontend served in a plain browser, proxying
// read-only Today endpoints to the live engine on :3020) with headless
// Chromium (Playwright) and saves real screenshots at 2x deviceScaleFactor
// into docs/user-guide-assets/.
//
// Two harness instances are used:
//   REAL  (:4651) — proxies the live corpus. Source of the hero shots
//                   (State of Play, Deadline outlook + Brian workback,
//                   Coming up, Needs attention, Log, Settings, Home).
//   DEMO  (:4652) — HARNESS_READINESS_DEMO=1. Injects due-soon fixture rows
//                   (amber "not on track" swimlane, fired workback,
//                   no-draft-observed + Draft heads-up) and the
//                   NAME-ASK (US-NON-22189) card.
//
// Run:  node scripts/capture-user-guide.mjs
// The playwright install lives in a scratch prefix (node_modules here is a
// symlink to the main checkout), passed via NODE_PATH.

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const REAL = process.env.REAL_URL || "http://localhost:4651";
const DEMO = process.env.DEMO_URL || "http://localhost:4652";
const OUT = process.env.OUT_DIR ||
  "/Users/rosscantrell/Projects/viktora-threshold/.claude/worktrees/blissful-mccarthy-eefa13/docs/user-guide-assets";

fs.mkdirSync(OUT, { recursive: true });

const WIDE = { width: 1380, height: 900 };
const NARROW = { width: 1100, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Click a nav/button by exact text.
async function clickByText(page, text) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("a,button")].find(
      (e) => e.textContent.trim() === t,
    );
    if (el) el.click();
  }, text);
}

// Navigate to a top-level view and wait for its data to settle.
async function gotoToday(page) {
  await clickByText(page, "Today");
  await page.waitForFunction(
    () => /Deadline outlook/i.test(document.body.innerText),
    { timeout: 20000 },
  ).catch(() => {});
  await sleep(2500);
}

async function shot(page, name, clip) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, clip });
  const sz = fs.statSync(file).size;
  console.log(`  saved ${name} (${sz} bytes)`);
  if (sz < 1000) throw new Error(`SUSPICIOUSLY SMALL: ${name} = ${sz}b`);
}

// Full-viewport shot.
async function shotFull(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  const sz = fs.statSync(file).size;
  console.log(`  saved ${name} (${sz} bytes)`);
  if (sz < 1000) throw new Error(`SUSPICIOUSLY SMALL: ${name} = ${sz}b`);
}

// Clip to a selector's bounding box (with padding).
async function shotEl(page, name, selector, pad = 12) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
  if (!box) throw new Error(`selector not found for ${name}: ${selector}`);
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
  await shot(page, name, clip);
}

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  return page;
}

async function main() {
  const browser = await chromium.launch();
  console.log("== REAL harness (" + REAL + ") ==");

  // ---- WIDGET PILL (widget.html) ----
  {
    const page = await newPage(browser, { width: 260, height: 140 });
    await page.goto(REAL + "/widget.html", { waitUntil: "networkidle" }).catch(() => {});
    await sleep(1500);
    await shotFull(page, "01-widget-pill.png");
    await page.context().close();
  }

  // ---- TODAY (wide) — hero, real data ----
  const page = await newPage(browser, WIDE);
  await page.goto(REAL + "/index.html", { waitUntil: "networkidle" }).catch(() => {});
  await sleep(1500);
  await gotoToday(page);
  await shotFull(page, "02-today-wide.png");

  // State of play digest (collapsed)
  await shotEl(page, "03-sop-digest.png", ".today-sop", 8);

  // Expand State of play ("Show more")
  await clickByText(page, "Show more");
  await sleep(1200);
  await shotEl(page, "04-sop-expanded.png", ".today-sop", 8);

  // ---- DEADLINE OUTLOOK panel (real bars/ticks/state) ----
  await gotoToday(page); // reset expansion
  await shotEl(page, "20-outlook-panel.png", ".today-outlook", 10);

  // Expand the Brian row → workback reasoning (traceback, checklist, closing line, gestures)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".today-outlook-row")];
    const brian = rows.find((r) => /Brian/.test(r.textContent));
    if (brian) brian.click();
  });
  await sleep(1800);
  await shotEl(page, "21-workback-expanded.png", ".today-outlook", 10);

  // Close-up of just the expanded details (traceback + checklist + gestures)
  await shotEl(
    page,
    "22-workback-details.png",
    ".today-outlook-item:has(.today-outlook-details:not([hidden])) .today-outlook-details",
    14,
  ).catch(async () => {
    // fallback: the visible details block
    const sel = await page.evaluate(() => {
      const d = [...document.querySelectorAll(".today-outlook-details")].find(
        (e) => e.textContent.trim().length > 0 && !e.hasAttribute("hidden"),
      );
      if (!d) return null;
      d.setAttribute("data-cap", "1");
      return "[data-cap='1']";
    });
    if (sel) await shotEl(page, "22-workback-details.png", sel, 14);
  });

  // ---- WAITING ON YOU: question card (real MERGE-ASK-style question) ----
  await gotoToday(page);
  await shotEl(page, "23-waiting-question.png", ".watching-waiting, .question-section", 10)
    .catch(() => console.log("  (waiting/question selector miss — skipping 23)"));

  // ---- COMING UP: due tags, receipts, follow-up ----
  await page.evaluate(() => {
    const e = document.querySelector(".today-comingup");
    if (e) e.scrollIntoView();
  });
  await sleep(800);
  await shotEl(page, "24-coming-up.png", ".today-comingup", 10)
    .catch(() => console.log("  (coming-up selector miss — skipping 24)"));

  // ---- NEEDS ATTENTION board ----
  await gotoToday(page);
  await page.evaluate(() => {
    const e = document.querySelector(".log-attention-groups, [class*='attention']");
    if (e) e.scrollIntoView();
  });
  await sleep(600);
  await shotEl(page, "06-attn-board.png", ".log-attention-groups, [class*='attention']", 10)
    .catch(() => console.log("  (attn board selector miss — skipping 06)"));

  // Expand first attention card
  await page.evaluate(() => {
    const card = document.querySelector(".log-attention-groups [role='button'], .log-attention-groups button, .attn-group");
    if (card) card.click();
  });
  await sleep(1000);
  await shotEl(page, "07-attn-card-expanded.png", ".log-attention-groups, [class*='attention']", 10)
    .catch(() => console.log("  (attn expanded selector miss — skipping 07)"));

  // ---- TODAY narrow (1100) ----
  {
    const np = await newPage(browser, NARROW);
    await np.goto(REAL + "/index.html", { waitUntil: "networkidle" }).catch(() => {});
    await sleep(1500);
    await gotoToday(np);
    await shotFull(np, "08-today-narrow.png");
    await np.context().close();
  }

  // ---- HOME ----
  await clickByText(page, "⌂");
  await sleep(1500);
  await shotFull(page, "10-home.png");

  // ---- LOG ----
  await clickByText(page, "Log");
  await sleep(2500);
  await shotFull(page, "11-log.png");

  // ---- SETTINGS panels ----
  async function settings(panel, name, prep) {
    await page.evaluate((p) => {
      // open settings then switch panel
      const gear = [...document.querySelectorAll("a,button")].find((e) => e.textContent.trim() === "⚙");
      if (gear) gear.click();
    }, panel);
    await sleep(800);
    await page.evaluate((p) => {
      const item = document.querySelector(`.settings-nav-item[data-panel='${p}']`);
      if (item) item.click();
    }, panel);
    await sleep(1500);
    if (prep) await prep();
    await sleep(500);
    await shotFull(page, name);
  }

  await settings("connection", "12-settings-connection.png");
  await settings("integrations", "13-settings-integrations.png");

  // Email capture — real "create address" empty state, then staged populated state.
  await settings("email-capture", "14-settings-email-capture.png", async () => {
    // Stage the "enter your email → create" state faithfully (source markup).
    await page.evaluate(() => {
      const body = document.getElementById("email-capture-body");
      if (!body) return;
      body.innerHTML =
        '<p class="field-help">Create a private capture address for this workspace. ' +
        "BCC or forward any email to it and Threshold files what it finds, then replies " +
        "with a receipt.</p>" +
        '<div class="ec-add-sender">' +
        '<input type="email" class="ec-sender-input" id="ec-owner-email" ' +
        'placeholder="you@company.com" value="ross.cantrell@viktora.ai" autocomplete="email" spellcheck="false" />' +
        "</div>" +
        '<p class="field-help">The address you’ll forward email from — it becomes the ' +
        "owner of your capture address.</p>" +
        '<div class="ec-actions"><button type="button" class="btn btn-primary" id="ec-create">' +
        "Create my capture address</button></div>";
    });
  });

  // Email capture — populated (address + approved senders), staged from source markup.
  await page.evaluate(() => {
    const body = document.getElementById("email-capture-body");
    if (!body) return;
    const addr = "cap-7fq2m9x4@in.viktora.ai";
    let html = "";
    html +=
      '<p class="field-help">Create a private capture address for this workspace. ' +
      "BCC or forward any email to it and Threshold files what it finds, then replies with a receipt.</p>";
    html +=
      '<div class="ec-address-row">' +
      '<code class="ec-address" id="ec-address">' + addr + "</code>" +
      '<button type="button" class="btn btn-secondary ec-copy" id="ec-copy">Copy</button>' +
      "</div>";
    html +=
      '<p class="field-help">BCC or forward any email to this address — Threshold files ' +
      "what it finds and replies with a receipt. Only senders you approve below are accepted.</p>";
    html +=
      '<div class="ec-actions"><button type="button" class="btn btn-secondary" id="ec-rotate">Rotate address</button></div>';
    html += '<h3 class="settings-subhead ec-senders-head">Approved senders</h3>';
    html += '<ul class="ec-senders">';
    for (const s of ["ross.cantrell@viktora.ai", "@viktora.ai"]) {
      html +=
        '<li class="ec-sender-row"><code class="ec-sender">' + s +
        '</code><button type="button" class="ec-sender-remove" aria-label="Remove ' + s + '">Remove</button></li>';
    }
    html += "</ul>";
    html +=
      '<div class="ec-add-sender">' +
      '<input type="text" class="ec-sender-input" id="ec-sender-input" ' +
      'placeholder="name@company.com or @company.com" autocomplete="off" spellcheck="false" />' +
      '<button type="button" class="btn btn-secondary" id="ec-sender-add">Add</button>' +
      "</div>";
    body.innerHTML = html;
  });
  await sleep(400);
  await shotFull(page, "16-email-capture-address.png");

  await settings("privacy", "15-settings-privacy.png");

  // ---- ONBOARDING wizard views (force-show the hidden sections) ----
  async function showView(id, name) {
    await page.evaluate((vid) => {
      // hide all views, show target
      for (const v of document.querySelectorAll(".view")) v.setAttribute("hidden", "");
      const t = document.getElementById(vid);
      if (t) { t.removeAttribute("hidden"); t.scrollIntoView(); }
    }, id);
    await sleep(800);
    await shotFull(page, name);
  }
  await showView("view-welcome", "30-onboarding-signin.png");
  await showView("view-check-inbox", "31-onboarding-link-sent.png");

  await page.context().close();

  // =====================================================================
  //  DEMO harness — amber states, fired workback, name-ask, no-draft
  // =====================================================================
  console.log("== DEMO harness (" + DEMO + ") ==");
  const dpage = await newPage(browser, WIDE);
  await dpage.goto(DEMO + "/index.html", { waitUntil: "networkidle" }).catch(() => {});
  await sleep(1500);
  await gotoToday(dpage);

  // Outlook panel with the amber "not on track" demo swimlane
  await shotEl(dpage, "25-outlook-amber.png", ".today-outlook", 10)
    .catch(() => console.log("  (demo outlook selector miss — 25)"));

  // Expand the fired-workback demo row (rd-demo-1, brian-keller)
  await dpage.evaluate(() => {
    const rows = [...document.querySelectorAll(".today-outlook-row")];
    // pick a row whose state text is "not on track"
    const amber = rows.find((r) => /not on track/i.test(r.textContent));
    if (amber) amber.click();
  });
  await sleep(1500);
  await shotEl(dpage, "26-workback-fired.png", ".today-outlook", 10)
    .catch(() => console.log("  (demo fired workback miss — 26)"));

  // Coming up with no-draft-observed + Draft heads-up (demo readiness rows)
  await dpage.evaluate(() => {
    const e = document.querySelector(".today-comingup");
    if (e) e.scrollIntoView();
  });
  await sleep(800);
  await shotEl(dpage, "27-coming-up-headsup.png", ".today-comingup", 10)
    .catch(() => console.log("  (demo coming-up miss — 27)"));

  // NAME-ASK card (US-NON-22189) — in Waiting on you
  await gotoToday(dpage);
  const nameAskSel = await dpage.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => /US-NON-22189/.test(e.textContent) && e.children.length &&
        e.className && /name|ask|card|question/i.test(e.className),
    );
    if (el) { el.setAttribute("data-cap", "nameask"); return "[data-cap='nameask']"; }
    return null;
  });
  if (nameAskSel) {
    await dpage.evaluate((s) => document.querySelector(s).scrollIntoView(), nameAskSel);
    await sleep(500);
    await shotEl(dpage, "28-name-ask.png", nameAskSel, 12)
      .catch(() => console.log("  (name-ask clip miss — 28)"));
  } else {
    console.log("  (NAME-ASK card not found in DOM — 28 skipped)");
  }

  await dpage.context().close();
  await browser.close();
  console.log("== DONE ==");
}

main().catch((e) => {
  console.error("CAPTURE FAILED:", e);
  process.exit(1);
});
