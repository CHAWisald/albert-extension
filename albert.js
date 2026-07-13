// albert.js — the real add-class automation for NYU Albert (Fluid), driven
// through the MAIN-world bridge. Injected (isolated world, all frames) by the
// popup's "Fill Albert's cart"; only the control frame (the one holding
// DERIVED_REGFRM1_CLASS_NBR) acts. bridge.js must already be injected
// world:"MAIN" into the same frame — the popup does that first.
//
// Flow, per queued class (a screen-detector loop, NOT a fixed sequence, because
// permission-required classes insert an extra screen):
//   set class nbr → bridge Enter → { recitation screen → pick the chosen
//   recitation by class number; Next screen → fill permission if asked, click
//   Next; success/error modal → report } until a result modal appears.
//
// Every page action goes through the bridge calling submitAction_win0 by name —
// the only thing that works here (isolated-world clicks are blocked by CSP, and
// javascript: hrefs don't run in our world). See recon-findings.md.
//
// =========================== HARD STOP ====================================
// THIS SCRIPT MUST NEVER ADVANCE PAST THE SHOPPING CART.
// It fills the cart (Step 1) and stops. It must NEVER trigger
// "Proceed to Step 2 of 3" (DERIVED_REGFRM1_LINK_ADD_ENRL), "Finish Enrolling",
// enroll, or validate. bridgeSubmit() refuses any control id/label matching
// FORBIDDEN, and the bridge (bridge.js) refuses them again in the MAIN world.
// The student reviews the cart and enrolls by hand at their appointment.
// Keep this block and both guards when editing.
// ===========================================================================

(() => {
  if (window.__STQ_ALBERT_RUNNING__) return; // guard against double injection
  window.__STQ_ALBERT_RUNNING__ = true;

  const CLASS_NBR_ID = "DERIVED_REGFRM1_CLASS_NBR";
  const ENTER_ID = "BUTTON_SMALL";              // must read "Enter" (SMALL_BUTTON is "Search")
  const NEXT_PREFIX = "DERIVED_CLS_DTL_NEXT_PB";
  const CANCEL_PREFIX = "DERIVED_CLS_DTL_CANCEL_PB";
  const REC_SELECT_PREFIX = "NYU_DERIVED_SR_ROW_STATUS";
  const RELATE_NBR_PREFIX = "SSR_CLS_TBL_R1_RELATE_CLASS_NBR";
  const PERM_PREFIX = "DERIVED_CLS_DTL_CLASS_PRMSN_NBR";
  const OK_SELECTOR = '[id="#ICOK"]';

  const FORBIDDEN_TEXT = /finish\s*enrolling|proceed\s+to\s+step|enroll|validate/i;
  const FORBIDDEN_ID = /LINK_ADD_ENRL|SSR_PB_SUBMIT|ENROLL|VALIDATE|STEP[23]/i;

  const CONFIG = { stepTimeoutMs: 15000, settleMs: 400, politeMs: 350, maxStepsPerClass: 14, interClassMs: 900 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/[\s ]+/g, " ").trim();
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const byId = (id) => document.getElementById(id);
  const text = (el) => norm(el && el.textContent);

  const labelOf = (el) =>
    norm([el.textContent, el.value, el.title, el.getAttribute("aria-label")].filter(Boolean).join(" "));

  // ---- bridge client (postMessage; matches bridge.js) ------------------------

  function bridgeCall(fn, args, timeoutMs = 8000) {
    const id = "a" + Math.random().toString(36).slice(2, 10);
    return new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.__stqBridge !== "result" || m.id !== id) return;
        cleanup();
        m.ok ? resolve(m.value) : reject(new Error(m.error));
      };
      const cleanup = () => { clearTimeout(t); window.removeEventListener("message", onMsg); };
      const t = setTimeout(() => { cleanup(); reject(new Error("bridge timeout")); }, timeoutMs);
      window.addEventListener("message", onMsg);
      window.postMessage({ __stqBridge: "call", id, fn, args }, window.location.origin);
    });
  }

  // Trigger a PeopleSoft control by the id in its submitAction_win0 href, after
  // refusing anything forbidden. This is the ONLY way we act on the page.
  async function bridgeSubmit(el, whatFor) {
    if (!el) throw new Error(`${whatFor}: control not found`);
    const lbl = labelOf(el);
    if (FORBIDDEN_TEXT.test(lbl)) throw new Error(`HARD STOP: refusing "${lbl.slice(0, 50)}"`);
    if (el.id && FORBIDDEN_ID.test(el.id)) throw new Error(`HARD STOP: refusing id "${el.id}"`);
    const href = el.getAttribute("href") || "";
    const m = href.match(/submitAction_win0\(\s*document\.win0\s*,\s*'([^']+)'\s*\)/);
    const actionId = m ? m[1] : el.id;
    if (FORBIDDEN_ID.test(actionId) || FORBIDDEN_TEXT.test(actionId)) {
      throw new Error(`HARD STOP: refusing action "${actionId}"`);
    }
    await bridgeCall("submitAction_win0", ["document.win0", actionId]);
  }

  // Set a value through the owning realm's native setter so PeopleSoft's
  // handlers notice, then fire input/change.
  function setNativeValue(el, value) {
    const win = el.ownerDocument.defaultView;
    const proto =
      el instanceof win.HTMLSelectElement ? win.HTMLSelectElement.prototype :
      el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype :
      win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  // ---- status + step log (so the first real run is observable) ---------------

  let stepLog = [];
  async function setStatus(i, state, message) {
    const { stq_status = {} } = await chrome.storage.local.get("stq_status");
    stq_status[i] = { state, message, log: stepLog.slice(-12) };
    await chrome.storage.local.set({ stq_status });
  }
  const logStep = (s) => { stepLog.push(`${new Date().toLocaleTimeString()} ${s}`); };
  const setRun = (state, message) => chrome.storage.local.set({ stq_run: { state, message, at: Date.now() } });

  // ---- screen detection ------------------------------------------------------

  // PeopleSoft's modal container nests the message alongside a message-number div
  // (#msgnum, "(0, 0)"), a "Message" heading, and the OK button — all of which
  // bleed into its textContent. So read the message element itself first, and
  // scrub the stragglers.
  const cleanModal = (t) =>
    norm(t)
      .replace(/\s*\(\d+,\s*\d+\)\s*/g, " ")   // message number, e.g. "(0, 0)"
      .replace(/^\s*Message\s*/i, "")          // modal heading
      .replace(/\s*\bOK\s*$/i, "")             // the dismiss button's label
      .trim();

  function resultModal() {
    for (const id of ["alertmsg", "shortmsg", "ptModContent_0"]) {
      const el = byId(id);
      if (!el || !visible(el)) continue;
      const t = cleanModal(el.textContent);
      if (t) return t;
    }
    return "";
  }

  function detectScreen() {
    const modal = resultModal();
    if (modal) {
      if (/has been added to your Shopping Cart/i.test(modal)) return { kind: "success", text: modal };
      if (/already in your Shopping Cart/i.test(modal)) return { kind: "duplicate", text: modal };
      return { kind: "error", text: modal };
    }
    const recSelects = [...document.querySelectorAll(`select[id^="${REC_SELECT_PREFIX}"]`)].filter(visible);
    const nextBtn = [...document.querySelectorAll(`a[id^="${NEXT_PREFIX}"]`)].find((a) => visible(a) && /^next$/i.test(text(a)));
    const perm = document.querySelector(`input[id^="${PERM_PREFIX}"]`);
    if (nextBtn) return { kind: "next", nextBtn, perm: perm && visible(perm) ? perm : null };
    if (recSelects.length) return { kind: "recitation", recSelects };
    if (byId(CLASS_NBR_ID) && visible(byId(CLASS_NBR_ID))) return { kind: "add" };
    return { kind: "unknown" };
  }

  // A signature that changes when the meaningful screen changes, so we can wait
  // for a transition and avoid re-acting on the same screen.
  const screenSig = (s) =>
    s.kind + "|" + (s.text || "").slice(0, 60) + "|" +
    (s.perm ? "perm" : "") + "|" +
    (s.nextBtn ? s.nextBtn.id : "") + "|" +
    (s.recSelects ? s.recSelects.length + "rec" : "");

  // After ANY submit, PeopleSoft does a server round-trip and swaps the screen's
  // innerHTML. That takes ~0.5–2s, so reading the DOM immediately still shows the
  // OLD screen — which is how "Enter" used to look like it bounced straight back
  // to the add screen and the flow died before ever reaching Next. Wait for the
  // refresh to arrive (mutations start) and finish (mutations stop) first.
  function settleAfterAction(timeout = CONFIG.stepTimeoutMs) {
    return new Promise((resolve) => {
      let done = false, quiet = null;
      const finish = () => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(quiet); clearTimeout(nothing); clearTimeout(hard);
        resolve();
      };
      const obs = new MutationObserver(() => {
        clearTimeout(nothing);           // the refresh landed
        clearTimeout(quiet);
        quiet = setTimeout(finish, CONFIG.settleMs); // …and has stopped changing
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const nothing = setTimeout(finish, 5000);   // nothing happened at all
      const hard = setTimeout(finish, timeout);   // never hang
    });
  }

  // Wait for PeopleSoft's partial refresh to settle on a new, stable screen.
  async function waitScreen(exclude, timeout = CONFIG.stepTimeoutMs) {
    const deadline = Date.now() + timeout;
    let last = null, stableSince = 0;
    while (Date.now() < deadline) {
      if (!byId(CLASS_NBR_ID) && !resultModal() && !document.querySelector(`a[id^="${NEXT_PREFIX}"]`)) {
        // control frame's document may have been torn down (full nav / SSO)
        if (!document.body) throw new Error("page navigated away (session/SSO?)");
      }
      const s = detectScreen();
      const sig = screenSig(s);
      const actionable = s.kind !== "unknown" && !(exclude && exclude(s));
      if (actionable) {
        if (sig === last) {
          if (Date.now() - stableSince >= CONFIG.settleMs) return s;
        } else { last = sig; stableSince = Date.now(); }
      }
      await sleep(150);
    }
    throw new Error(`timed out waiting for the next screen (last: ${last || "none"})`);
  }

  // ---- modal dismissal -------------------------------------------------------
  // #ICOK's action lives in onclick (not a submitAction_win0 href), so the
  // bridge can't call it by name. A synthetic click runs inline onclick handlers
  // page-side. Best-effort: the class is already in the cart either way.
  async function dismissModal() {
    const ok = document.querySelector(OK_SELECTOR);
    if (!ok) return "no OK button";
    try { ok.click(); } catch { /* ignore */ }
    for (let i = 0; i < 12; i++) { await sleep(150); if (!resultModal()) return "dismissed"; }
    return "OK click did not close the modal (class still added; modal left open)";
  }

  // ---- recitation matching ---------------------------------------------------
  //
  // Albert prints schedules as "Fr 8:00AM - 9:15AM" (12-hour + AM/PM, day
  // abbreviations Mo..Su). Einstein stores them as {meet_day, start_time}, and we
  // do NOT assume either format: start_time may be minutes-since-midnight, a
  // 24-hour string ("13:30"), or a 12-hour one, and meet_day's 0-index origin
  // (Monday? Sunday?) is unknown. Both are normalized below, and the day origin
  // is CALIBRATED from the lecture — whose class number is a confirmed match
  // between the two systems, and whose schedule Albert shows on this very screen.

  const DAY_ABBR = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]; // index 0..6, Mon-first

  // Any Einstein time → minutes since midnight.
  function toMinutes(v) {
    if (v == null) return null;
    if (typeof v === "number") return v >= 0 && v <= 1439 ? v : null; // minutes since midnight
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);         // "9:30AM"
    if (m) return ((+m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + (+m[2]);
    m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);                    // "09:30" / "13:30:00"
    if (m) return (+m[1]) * 60 + (+m[2]);
    if (/^\d+$/.test(s)) { const n = +s; return n >= 0 && n <= 1439 ? n : null; }
    return null;
  }

  // Any Einstein day → index into DAY_ABBR. Integers get the calibrated offset.
  const DAY_WORDS = {
    m: 0, mo: 0, mon: 0, monday: 0,
    tu: 1, tue: 1, tues: 1, tuesday: 1,
    w: 2, we: 2, wed: 2, wednesday: 2,
    th: 3, thu: 3, thur: 3, thurs: 3, thursday: 3, r: 3,
    f: 4, fr: 4, fri: 4, friday: 4,
    sa: 5, sat: 5, saturday: 5,
    su: 6, sun: 6, sunday: 6,
  };
  function toDayIdx(v, offset = 0) {
    if (v == null) return null;
    if (typeof v === "number") return (((v + offset) % 7) + 7) % 7;
    const s = String(v).trim().toLowerCase();
    if (/^\d+$/.test(s)) return (((+s + offset) % 7) + 7) % 7;
    return DAY_WORDS[s] ?? null;
  }

  // "MoWe 11:00AM - 12:15PM" → { days:["Mo","We"], startMin:660 }. The day cluster
  // is anchored to the time so room names like "Warren Weaver" can't inject a "We".
  function parseSchedule(s) {
    const str = norm(s);
    const m = str.match(/((?:Mo|Tu|We|Th|Fr|Sa|Su)+)\s*(\d{1,2}):(\d{2})\s*([AP])M/i);
    if (m) {
      return {
        days: m[1].match(/Mo|Tu|We|Th|Fr|Sa|Su/g) || [],
        startMin: ((+m[2]) % 12 + (/p/i.test(m[4]) ? 12 : 0)) * 60 + (+m[3]),
      };
    }
    const t = str.match(/(\d{1,2}):(\d{2})\s*([AP])M/i);
    if (!t) return { days: [], startMin: null };
    return { days: [], startMin: ((+t[1]) % 12 + (/p/i.test(t[3]) ? 12 : 0)) * 60 + (+t[2]) };
  }

  // Each recitation row's schedule lives in a MTG_SCHED span whose id ends with
  // "$<rowIndex>" (the middle grid number varies).
  function scheduleForRow(idx) {
    const el = [...document.querySelectorAll('[id^="DERIVED_CLS_DTL_SSR_MTG_SCHED_LONG"]')]
      .find((s) => s.id.endsWith("$" + idx));
    return el ? text(el) : "";
  }

  // Albert shows the chosen LECTURE's schedule on the recitation screen, e.g.
  // "Section 001MoWe 11:00AM - 12:15PM 251 Mercer St (Warren Weaver)…".
  function lectureScheduleText() {
    const el = document.querySelector('[id^="DERIVED_CLS_DTL_SSS_LONGCHAR"]');
    return el ? text(el) : "";
  }

  // Derive Einstein's integer day origin by aligning its LECTURE meetings with the
  // lecture schedule Albert is showing. Returns an offset, or null if it can't tell.
  function calibrateDayOffset(item) {
    const albert = parseSchedule(lectureScheduleText());
    const lec = (item.lectureMeetings || []).filter((m) => typeof m.day === "number");
    if (!albert.days.length || !lec.length) return null;
    const want = new Set(albert.days.map((d) => DAY_ABBR.indexOf(d)));
    for (let off = 0; off < 7; off++) {
      const got = new Set(lec.map((m) => (((m.day + off) % 7) + 7) % 7));
      if (got.size === want.size && [...got].every((g) => want.has(g))) return off;
    }
    return null;
  }

  // minutes since midnight → "9:30AM"
  function fmtTime(min) {
    if (min == null) return "?";
    const h24 = Math.floor(min / 60), mm = String(min % 60).padStart(2, "0");
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h}:${mm}${h24 >= 12 ? "PM" : "AM"}`;
  }

  // Every recitation this lecture actually offers, with its number, section and
  // schedule — so a failure can tell the student exactly what to choose from.
  function offeredRecitations() {
    return [...document.querySelectorAll(`span[id^="${RELATE_NBR_PREFIX}"]`)]
      .map((r) => {
        const idx = (r.id.match(/\$(\d+)$/) || [])[1];
        if (idx == null) return null;
        const tr = document.querySelector(`[id^="SSR_CLS_TBL_R1"][id$="_row_${idx}"]`);
        const section = tr ? (norm(tr.textContent).match(/Section:\s*(\S+)/) || [])[1] : null;
        return { idx, classNbr: text(r), section: section || null, schedule: scheduleForRow(idx) };
      })
      .filter(Boolean);
  }

  // Full day names read better than Albert's "Mo"/"Fr" abbreviations.
  const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const prettyDays = (abbrs) => abbrs.map((a) => DAY_FULL[DAY_ABBR.indexOf(a)] || a).join(" & ");

  // What the student's chosen secondary component is called ("recitation", "lab"…).
  const componentWord = (item) => {
    const sec = (item.components || []).slice(1)[0];
    return (sec && sec.type ? String(sec.type) : "recitation").toLowerCase();
  };

  // The offered options as a bullet list the student can act on.
  const offeredBullets = (list, word) =>
    list.length
      ? list.map((o) => {
          const s = parseSchedule(o.schedule);
          const when = s.days.length && s.startMin != null
            ? `${prettyDays(s.days)} ${fmtTime(s.startMin)}`
            : o.schedule || "time not listed";
          return `• Section ${o.section || "?"} (#${o.classNbr}) — ${when}`;
        }).join("\n")
      : `• (this lecture lists no open ${word}s)`;

  // Returns { idx, note? } on success, or { idx:null, reason } on failure.
  function findRecitationIndex(item) {
    const rows = offeredRecitations();
    const word = componentWord(item);

    // 1. exact class number (the reliable path when Einstein and Albert agree).
    const wantNbr = item.recitationClassNbr && String(item.recitationClassNbr);
    let hit = wantNbr && rows.find((r) => r.classNbr === wantNbr);
    if (hit) return { idx: hit.idx };

    // 2. section number.
    if (item.recitationSection) {
      hit = rows.find((r) => r.section && String(r.section).replace(/^0+/, "") ===
        String(item.recitationSection).replace(/^0+/, ""));
      if (hit) return { idx: hit.idx };
    }

    // 3. by meeting time — Einstein records a component whose number Albert
    //    doesn't offer under this lecture, but day+start identifies the right one.
    //    Day origin and time format are derived, not assumed.
    //    THE DAY MUST MATCH. A same-time-but-wrong-day section is the wrong class,
    //    so we refuse it rather than quietly put it in the cart.
    const refuse = (headline) => ({
      idx: null,
      reason: `${headline}\n\nThis lecture offers:\n${offeredBullets(rows, word)}\n\nPlease adjust your schedule accordingly.`,
    });

    const raw = item.recitationMeetings || [];
    if (!raw.length) {
      return refuse(`No meeting time recorded for your selected ${word}, so it can't be matched.`);
    }

    const offset = calibrateDayOffset(item);
    // Diagnostic, not part of the student-facing message.
    logStep(offset == null
      ? "day origin not calibrated (lecture schedule unavailable) — assumed Monday = 0"
      : `day origin calibrated from the lecture (Einstein day 0 = ${DAY_FULL[toDayIdx(0, offset)]})`);

    const meetings = raw
      .map((m) => ({ day: toDayIdx(m.day, offset ?? 0), start: toMinutes(m.start) }))
      .filter((m) => m.start != null);
    const wanted = meetings
      .map((m) => `${m.day != null ? DAY_FULL[m.day] : "?"} ${fmtTime(m.start)}`)
      .join(" / ") || "an unknown time";

    const parsed = rows.map((r) => ({ ...r, sched: parseSchedule(r.schedule) }));
    const matches = parsed.filter((r) =>
      meetings.some((m) => m.day != null && r.sched.startMin === m.start && r.sched.days.includes(DAY_ABBR[m.day])));

    if (!matches.length) {
      return refuse(`No ${word} on ${wanted}. Your selected ${word} isn't offered under this lecture.`);
    }

    const chosen = matches[0];
    const note = matches.length > 1
      ? `Matched ${word} by time — ${matches.length} share ${wanted}, used Section ${chosen.section || "?"} (#${chosen.classNbr}).`
      : `Matched ${word} by time — Section ${chosen.section || "?"} (#${chosen.classNbr}, ${chosen.schedule}).`;
    return { idx: chosen.idx, note };
  }

  // ---- one class -------------------------------------------------------------

  async function addOne(i, item) {
    stepLog = [];
    await setStatus(i, "working", "entering class number");
    logStep(`enter class ${item.classNbr}`);

    const input = byId(CLASS_NBR_ID);
    if (!input) throw new Error("class-number input vanished");
    setNativeValue(input, String(item.classNbr));
    await sleep(CONFIG.politeMs);

    const enter = byId(ENTER_ID);
    if (!enter || !/^enter$/i.test(labelOf(enter))) throw new Error("Enter button not found/verified");
    await bridgeSubmit(enter, "Enter");
    await settleAfterAction(); // don't read the screen until the refresh lands

    let picked = false, permFilled = false, wlHandled = false;
    const notes = [];
    for (let step = 0; step < CONFIG.maxStepsPerClass; step++) {
      // While a recitation still needs picking, don't accept the bare recitation
      // screen as "stable" if we haven't picked yet — but after picking, the Next
      // appears on the same screen, so allow it.
      const s = await waitScreen(null);
      logStep(`screen: ${s.kind}${s.text ? " — " + s.text.slice(0, 60) : ""}`);
      await setStatus(i, "working", s.kind === "next" ? "confirming selections" : `on ${s.kind} screen`);

      if (s.kind === "success") {
        const d = await dismissModal(); logStep(`success; modal ${d}`);
        return { state: "in-cart", message: [s.text.slice(0, 120), ...notes].join(" — ") };
      }
      if (s.kind === "duplicate") {
        const d = await dismissModal(); logStep(`duplicate; modal ${d}`);
        return { state: "in-cart", message: ["already in your cart", ...notes].join(" — ") };
      }
      if (s.kind === "error") {
        await dismissModal();
        throw new Error(s.text.slice(0, 160));
      }

      if (s.kind === "recitation" && !picked) {
        const { idx, reason, note } = findRecitationIndex(item);
        if (idx == null) {
          // Refuse rather than add a wrong-day recitation. cancelIfMidFlow() in the
          // caller backs out of this class, and the run continues with the next.
          throw new Error(reason || "could not identify the recitation to pick");
        }
        if (note) { logStep(note); notes.push(note); }
        const sel = byId(`${REC_SELECT_PREFIX}$${idx}`);
        if (!sel) throw new Error(`recitation select $${idx} missing`);
        logStep(`pick recitation (row $${idx})`);
        setNativeValue(sel, "Y");
        await sleep(CONFIG.politeMs);
        await bridgeSubmit(sel, "recitation select");
        await settleAfterAction(); // the Next button only appears after this lands
        picked = true;
        continue;
      }

      if (s.kind === "next") {
        // Waitlist opt-in. A full class shows "Wait list if class is full?" as a
        // SELECT (DERIVED_CLS_DTL_WAIT_LIST_OKAY$N), options ""/N/Y — not a
        // checkbox. It's a preference read at Next, so set the value and let Next
        // submit it. Set it once, then re-detect (setting it may itself refresh).
        if (!wlHandled) {
          const wl = document.querySelector('select[id^="DERIVED_CLS_DTL_WAIT_LIST_OKAY"]');
          if (wl && visible(wl)) {
            wlHandled = true;
            const want = item.waitlistOk ? "Y" : "N";
            if (wl.value !== want) {
              logStep(`wait-list-if-full = ${want === "Y" ? "Yes" : "No"}`);
              setNativeValue(wl, want);
              await settleAfterAction(5000); // in case setting it triggers a refresh
              continue; // fresh Next reference next iteration
            }
          }
        }
        // A permission field is often PRESENT but OPTIONAL. Fill it only if the
        // student gave one; never abort just because the field exists. If it's
        // truly required, clicking Next returns an error modal, reported below.
        if (s.perm && item.permissionNbr && !permFilled) {
          logStep(`fill permission ${item.permissionNbr}`);
          setNativeValue(s.perm, String(item.permissionNbr));
          permFilled = true;
          await sleep(CONFIG.politeMs);
        }
        logStep(`click Next (${s.nextBtn.id}${s.perm ? ", perm field present" : ""})`);
        await sleep(CONFIG.politeMs);
        await bridgeSubmit(s.nextBtn, "Next");
        await settleAfterAction();
        continue;
      }

      if (s.kind === "recitation" && picked) { await sleep(300); continue; } // waiting for Next to appear
      // Only a genuine bounce now — every submit above waits for its refresh to land.
      if (s.kind === "add") throw new Error("came back to the add screen with no result (class may have been rejected)");
    }
    throw new Error("gave up after too many screens without a result");
  }

  // ---- backing out of a half-finished class ----------------------------------
  async function cancelIfMidFlow() {
    const cancel = [...document.querySelectorAll(`a[id^="${CANCEL_PREFIX}"]`)].find((a) => /^cancel$/i.test(text(a)));
    if (cancel) { try { await bridgeSubmit(cancel, "Cancel"); await sleep(500); } catch { /* ignore */ } }
  }

  // ---- clear the shopping cart ------------------------------------------------
  //
  // Verified against a real populated cart: each lecture row has a "select this
  // class" dropdown `select#P_SELECT$N` (options ""/N/Y); labs/recitations are
  // tied to their lecture and carry no selector. The global Delete button is
  // `a#DERIVED_REGFRM1_SSR_PB_DELETE`. So: set every P_SELECT to Y, click Delete
  // (via the bridge), confirm the "are you sure?" modal, repeat until empty.
  // Deleting from the cart is reversible and never enrolls (Validate / Enroll /
  // Proceed are all in the forbidden list and bridgeSubmit refuses them).

  const cartEmpty = () => {
    const e = document.querySelector('[id^="P_NO_CLASSES"]');
    return (e && visible(e) && /empty/i.test(text(e))) || cartRows().length === 0;
  };
  const cartRows = () =>
    [...document.querySelectorAll('[id^="SSR_REGFORM_VW"][id*="_row_"]')]
      .filter((r) => visible(r) && !/empty/i.test(text(r)));

  const rowSelects = () => [...document.querySelectorAll('select[id^="P_SELECT"]')].filter(visible);
  const deleteButton = () =>
    (byId("DERIVED_REGFRM1_SSR_PB_DELETE") && /^delete$/i.test(text(byId("DERIVED_REGFRM1_SSR_PB_DELETE")))
      ? byId("DERIVED_REGFRM1_SSR_PB_DELETE") : null) ||
    [...document.querySelectorAll('a.ps-button, a[id*="SSR_PB_DELETE"]')]
      .find((a) => /^delete$/i.test(text(a)) && !FORBIDDEN_ID.test(a.id || "") && !FORBIDDEN_TEXT.test(labelOf(a)));

  const fullCartDump = () => ({
    rows: cartRows().map((r) => ({ id: r.id, text: text(r).slice(0, 100) })),
    rowSelects: rowSelects().map((s) => ({ id: s.id, value: s.value })),
    clickables: [...document.querySelectorAll('a, button, [role="button"], input')]
      .filter(visible).slice(0, 60)
      .map((el) => ({ id: el.id || null, tag: el.tagName.toLowerCase(), type: el.type || null, text: labelOf(el).slice(0, 40), href: (el.getAttribute("href") || "").slice(0, 80) })),
  });

  // Confirmation modals ("Are you sure?"): Yes (#ICYes) or OK (#ICOK). Their
  // action is in onclick, so a synthetic click runs it page-side (the CSP notice
  // about the javascript:void(0) href is harmless — the handler still fires).
  async function confirmModal() {
    for (let i = 0; i < 16; i++) {
      const btn = document.querySelector('[id="#ICYes"]') || document.querySelector('[id="#ICOK"]');
      if (btn && visible(btn)) { try { btn.click(); } catch { /* ignore */ } }
      await sleep(200);
      if (!document.querySelector('[id="#ICYes"]') && !resultModal()) return true;
    }
    return false;
  }

  async function clearCart() {
    if (!byId(CLASS_NBR_ID) && !document.querySelector('[id^="SSR_REGFORM_VW"]')) return; // not the cart frame
    try {
      const pong = await bridgeCall("__ping", [], 5000);
      if (!pong || !pong.hasSubmitFn) throw new Error("bridge not present");
    } catch (e) {
      await setRun("blocked", "The page bridge isn't responding (" + e.message + "). Reload Albert and retry.");
      return;
    }

    if (cartEmpty()) { await setRun("done", "Your Albert cart is already empty."); return; }

    let removed = 0;
    for (let pass = 0; pass < 12; pass++) {
      if (cartEmpty()) break;
      const before = cartRows().length;
      const sels = rowSelects();
      const del = deleteButton();
      if (!sels.length || !del) {
        await chrome.storage.local.set({ stq_cart_debug: fullCartDump() });
        await setRun("blocked",
          `${before} class(es) in the cart, but I couldn't find the ${!sels.length ? "row selectors" : "Delete button"}. ` +
          `Captured the cart page — paste the developer report and I'll adjust.`);
        return;
      }

      // Select every deletable row (P_SELECT → Yes). It's read on Delete's submit,
      // so setting the value + change is enough; no per-row submit needed.
      await setRun("running", `Selecting ${sels.length} class(es) to delete…`);
      for (const s of sels) { setNativeValue(s, "Y"); await sleep(CONFIG.politeMs); }
      await sleep(CONFIG.settleMs);

      await setRun("running", `Deleting ${sels.length} class(es)…`);
      try { await bridgeSubmit(del, "Delete"); }
      catch (e) { await setRun("stopped", "Stopped: " + e.message); return; }
      await confirmModal();

      // Wait for the cart to shrink.
      const deadline = Date.now() + CONFIG.stepTimeoutMs;
      let shrank = false;
      while (Date.now() < deadline) {
        await sleep(250);
        if (cartEmpty() || cartRows().length < before) { shrank = true; break; }
      }
      if (!shrank) {
        await chrome.storage.local.set({ stq_cart_debug: fullCartDump() });
        await setRun("stopped", "Selected the classes and clicked Delete, but the cart didn't shrink. Captured the cart page.");
        return;
      }
      removed += before - cartRows().length;
    }
    await setRun("done", cartEmpty()
      ? `Cart cleared — removed ${removed} class(es).`
      : `Removed ${removed}; some classes may remain. Try again or clear them by hand.`);
  }

  // ---- main ------------------------------------------------------------------

  async function main() {
    const { stq_run_mode = "fill" } = await chrome.storage.local.get("stq_run_mode");

    if (stq_run_mode === "clearcart") return clearCart();

    // Only the frame that owns the class-number input acts.
    if (!byId(CLASS_NBR_ID)) return;

    // Confirm the bridge is live in this frame before doing anything.
    try {
      const pong = await bridgeCall("__ping", [], 5000);
      if (!pong || !pong.hasSubmitFn) throw new Error("submitAction_win0 not present");
    } catch (e) {
      await setRun("blocked", "The page bridge isn't responding (" + e.message + "). Reload Albert and retry.");
      return;
    }

    const { stq_queue = [], stq_status = {} } = await chrome.storage.local.get(["stq_queue", "stq_status"]);
    if (!stq_queue.length) { await setRun("blocked", "Queue is empty — import or paste class numbers first."); return; }

    await setRun("running", `Filling cart: ${stq_queue.length} class(es).`);
    let added = 0, failed = 0;

    for (let i = 0; i < stq_queue.length; i++) {
      const item = stq_queue[i];
      if (stq_status[i]?.state === "in-cart") { added++; continue; } // idempotent re-run
      if (!item.classNbr) { await setStatus(i, "failed", "no class number"); failed++; continue; }

      try {
        const res = await addOne(i, item);
        await setStatus(i, res.state, res.message);
        added++;
      } catch (e) {
        // A failed class never stops the run — record why and move on. Best-effort
        // recovery back to the add screen so the next class can be entered; if it
        // can't recover, the next addOne fails fast with its own clear reason.
        await setStatus(i, "failed", e.message);
        failed++;
        await dismissModal().catch(() => {});
        await cancelIfMidFlow();
        try { await waitScreen((s) => s.kind !== "add", 6000); } catch { /* keep going regardless */ }
      }
      await sleep(CONFIG.interClassMs);
    }

    await setRun("done",
      `Done. ${added} in cart${failed ? `, ${failed} failed (see each class for why)` : ""}. Review and enroll by hand.`);
  }

  main()
    .catch(async (e) => { await setRun("error", "Run crashed: " + e.message); })
    .finally(() => { window.__STQ_ALBERT_RUNNING__ = false; });
})();
