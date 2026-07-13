// probe.js — reconnaissance of the REAL Albert add-class screen, run from a
// content script's isolated world (the world albert.js will actually live in).
//
// v2. v1 assumed the Classic PeopleSoft DOM in recon-findings.md: a class-number
// input sharing a <tr> with an <a class="ps-button">Enter</a>. The Fall 2026 page
// is FLUID (NYU_SSENRL_CART_FL.GBL) and has neither. So this version assumes
// nothing about structure — it dumps what is there and lets us decide.
//
// Questions still open:
//   Q1a Can the top frame reach the Albert frame's DOM? (v1: yes — but the two
//       are different origins, so this rides on PeopleSoft's document.domain
//       relaxation. Confirmed here by reporting document.domain directly.)
//   Q1b Does submitting do a partial refresh (XHR/fetch) or a real navigation?
//   Q2  RESOLVED (2026-07-10): a click from the isolated world does NOT drive
//       PeopleSoft — anchor.click() on BUTTON_SMALL set the value but fired no
//       network/DOM/nav change. Blink ran the javascript: href in the isolated
//       world, where submitAction_win0 is undefined. The bridge is mandatory;
//       the "bridge:" action validates it end-to-end with the 99999 no-op.
//
// Modes (chrome.storage.local key `stq_probe_mode`):
//
//   "read"    Touches nothing. Dumps frames, the input's ancestry and attributes,
//             every clickable on the page, and where result messages could land.
//
//   "cart"    Touches nothing. Dumps the shopping-cart rows and any delete/
//             remove controls, so the Clear Cart flow can be built from verified
//             DOM. (Delete controls only exist once the cart has items.)
//
//   "submit"  Performs ONE action, named explicitly in `stq_probe_action`:
//               "bridge:<elementId>" — set value, then call submitAction_win0
//                                      via the MAIN-world bridge (the real path)
//               "click:<elementId>"  — click that exact element (proven inert)
//               "key:Enter"          — press Enter in the box (proven inert)
//             There is no default and no guessing: with no action set, it
//             refuses to act. It types class nbr 99999, which is not a real
//             class, so the expected outcome is a "not found" message.
//             Nothing reaches the cart: Enter only opens a class's screens.
//
//   "perm:<lecture>:<rec>:<code>"   (a submit action; rec may be empty)
//             ⚠ THE ONE ACTION THAT CAN REACH THE CART. Everything above stops
//             before the commit Next; this one drives it, on purpose, because
//             Albert's response to a BAD PERMISSION CODE cannot be observed any
//             other way — the error only exists as the reply to that submit.
//             Walks: Enter <lecture> → pick <rec> (or the first offered, or skip
//             if the class has no components) → Next → Enrollment Preferences →
//             type <code> into DERIVED_CLS_DTL_CLASS_PRMSN_NBR → Next → capture
//             whatever comes back → dismiss → Cancel.
//             It captures the modal at TWO points, because a bad code can fail in
//             two different places: (a) the field's own onchange runs PeopleSoft's
//             numeric doEdits, so a non-numeric code like "sdjksd" may be refused
//             CLIENT-side the moment it's typed, before any submit; (b) a
//             well-formed but wrong code is refused SERVER-side at Next.
//             If the code is somehow ACCEPTED the class lands in the shopping
//             cart — that is recoverable (Clear Albert's cart) and never enrolls,
//             and the report says `landedInCart: true` so you know to clear it.
//             Message text is reported raw AND escaped (\u00a0 etc.) so the exact
//             string can go into recon-findings.md.
//
// ============================ HARD STOP ===================================
// No action is performed against any element whose visible label OR id matches
// FORBIDDEN_TEXT / FORBIDDEN_ID. On this page that blocks
// DERIVED_REGFRM1_LINK_ADD_ENRL ("Proceed to Step 2 of 3"), which is the path
// toward enrolling. The hard stop is unchanged and absolute: NOTHING here can
// enroll, validate, or advance past the shopping cart.
//
// It used to also be true that "this probe has no code path that reaches the
// cart". As of v2.4.0 that is NO LONGER TRUE for the `perm:` action, which
// drives the commit Next deliberately (see above) and can therefore add a class
// to the CART — the same thing the Fill button does every day, undone by Clear
// Albert's cart. Every other action still stops short of it. Don't quietly widen
// that: if you add another action that commits, say so here.
// ==========================================================================

(() => {
  if (window.__STQ_PROBE_RUNNING__) return;
  window.__STQ_PROBE_RUNNING__ = true;

  const CLASS_NBR_ID = "DERIVED_REGFRM1_CLASS_NBR";
  const PROBE_NBR = "99999";

  const FORBIDDEN_TEXT = /finish\s*enrolling|proceed\s+to\s+step|enroll|validate/i;
  const FORBIDDEN_ID = /LINK_ADD_ENRL|SSR_PB_SUBMIT|ENROLL|VALIDATE|STEP[23]/i;

  const ID_PREFIXES = [
    "DERIVED_REGFRM1_",
    "DERIVED_CLS_DTL_",
    "NYU_DERIVED_",
    "SSR_",
  ];

  const CLICKABLE =
    "a, button, input[type=button], input[type=submit], input[type=image], [role=button], [onclick]";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0;

  // PeopleSoft pads text and uses U+00A0; normalize before any comparison.
  const norm = (s) => (s || "").replace(/[\s ]+/g, " ").trim();

  // Albert puts EMPLID in every URL. Keep the term, drop the identity.
  function redact(u) {
    try {
      const x = new URL(u);
      const keep = new URLSearchParams();
      for (const k of ["STRM", "ACAD_CAREER", "INSTITUTION"]) {
        if (x.searchParams.has(k)) keep.set(k, x.searchParams.get(k));
      }
      const q = keep.toString();
      return x.origin + x.pathname + (q ? "?" + q : "");
    } catch {
      return String(u).split("?")[0];
    }
  }

  const labelOf = (el) =>
    norm([el.textContent, el.value, el.title, el.getAttribute("aria-label")]
      .filter(Boolean).join(" "));

  const waitFor = async (test, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { await sleep(250); if (test()) return true; }
    return false;
  };

  // recon-findings.md already had to flag that Albert's duplicate message hides a
  // U+00A0 in it — a normalized capture would have lost that. So permission-error
  // text is reported BOTH ways: `norm`ed for reading, and escaped so every
  // non-ASCII character is visible and can be copied into the findings verbatim.
  const escapeExact = (s) =>
    JSON.stringify(String(s == null ? "" : s))
      .replace(/[\u0080-\uFFFF]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

  // Every place Albert is known to put a message, read straight off the element
  // rather than off a container that would drag #msgnum and the OK label in.
  function messageText(doc) {
    for (const id of ["alertmsg", "shortmsg", "ptModContent_0"]) {
      const el = doc.getElementById(id);
      if (!el || !visible(el)) continue;
      const raw = el.textContent;
      if (norm(raw)) return { from: "#" + id, text: norm(raw), exact: escapeExact(raw) };
    }
    return null;
  }

  function assertAllowed(el) {
    const l = labelOf(el);
    if (FORBIDDEN_TEXT.test(l)) throw new Error(`HARD STOP: label "${l.slice(0, 60)}"`);
    if (el.id && FORBIDDEN_ID.test(el.id)) throw new Error(`HARD STOP: id "${el.id}"`);
  }

  // Cross-realm safe: an element from a subframe is not an instanceof THIS
  // frame's HTMLInputElement, so read the prototype off its own window.
  function setNativeValue(el, value) {
    const win = el.ownerDocument.defaultView;
    // Pick the prototype off the TAG, not off instanceof. A PeopleSoft id prefix
    // matches the label and the wrapper as well as the field, so a sloppy selector
    // hands this a <label> — and the native setter then throws "Illegal
    // invocation", which names neither the element nor the selector that found it.
    // Say what actually happened instead. (This is a real bug we hit, not a
    // hypothetical: v2.4.1's perm: probe died exactly here.)
    const tag = el.tagName;
    const proto =
      tag === "SELECT" ? win.HTMLSelectElement.prototype :
      tag === "TEXTAREA" ? win.HTMLTextAreaElement.prototype :
      tag === "INPUT" ? win.HTMLInputElement.prototype :
      null;
    if (!proto) {
      throw new Error(
        `setNativeValue got <${tag.toLowerCase()}${el.id ? "#" + el.id : ""}>, which has no value to set — ` +
        `the selector that found it is matching a label or wrapper, not the field`
      );
    }
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  // ---- isolated-world caller for the MAIN-world bridge -----------------------
  //
  // Talks to bridge.js over window.postMessage (see bridge.js for why not
  // CustomEvent). Must run in the SAME frame as the bridge — a same-window post
  // is what both worlds share. Resolves with the call's return value, or
  // rejects if the bridge is absent (timeout) or refused the call.
  function bridgeCall(fn, args, timeoutMs = 6000) {
    const callId = "c" + Math.random().toString(36).slice(2, 10);
    return new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.__stqBridge !== "result" || m.id !== callId) return;
        cleanup();
        m.ok ? resolve(m.value) : reject(new Error(m.error));
      };
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
      };
      const timer = setTimeout(
        () => { cleanup(); reject(new Error("bridge timeout — MAIN-world bridge not installed or not responding")); },
        timeoutMs
      );
      window.addEventListener("message", onMsg);
      window.postMessage({ __stqBridge: "call", id: callId, fn, args }, window.location.origin);
    });
  }

  // PeopleTools 8.6x partial refresh is XHR; count fetch too, in case.
  const netCount = (win) => {
    try {
      return win.performance.getEntriesByType("resource")
        .filter((e) => e.initiatorType === "xmlhttprequest" || e.initiatorType === "fetch").length;
    } catch {
      return null;
    }
  };

  // ---- structural dump -------------------------------------------------------

  const describe = (el) => ({
    id: el.id || null,
    tag: el.tagName.toLowerCase(),
    text: labelOf(el).slice(0, 60),
    cls: (el.className || "").toString().slice(0, 60) || null,
    href: (el.getAttribute("href") || "").slice(0, 120) || null,
    hasOnclick: !!el.getAttribute("onclick"),
    visible: visible(el),
  });

  const attrsOf = (el) =>
    Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 200)]));

  function ancestorChain(el, depth) {
    const out = [];
    let cur = el.parentElement;
    while (cur && out.length < depth) {
      out.push(
        cur.tagName.toLowerCase() +
        (cur.id ? "#" + cur.id : "") +
        (cur.className ? "." + String(cur.className).trim().split(/\s+/).slice(0, 2).join(".") : "")
      );
      cur = cur.parentElement;
    }
    return out;
  }

  // ---- shopping-cart capture (for the Clear Cart feature) --------------------
  //
  // Reads-only. The cart lives in SSR_REGFORM_VW rows; deletion controls are
  // unknown until a real cart has items, so this dumps whatever delete/remove
  // controls and per-row checkboxes exist for us to build against — never acts.
  function describeCart(doc) {
    const rows = [...doc.querySelectorAll('[id^="SSR_REGFORM_VW"]')].map((el) => ({
      id: el.id, tag: el.tagName.toLowerCase(), text: norm(el.textContent).slice(0, 100),
    }));
    const emptyMsg = [...doc.querySelectorAll('[id^="P_NO_CLASSES"]')].map((el) => norm(el.textContent));
    const isEmpty =
      emptyMsg.some((t) => /empty/i.test(t)) ||
      (rows.length > 0 && rows.every((r) => /empty/i.test(r.text)));

    const deleteControls = [...doc.querySelectorAll(CLICKABLE)]
      .filter((el) => /delete|remove|drop|trash/i.test(labelOf(el)) || /DELETE|REMOVE|TRASH|DROP/i.test(el.id || ""))
      .filter((el) => !(FORBIDDEN_TEXT.test(labelOf(el)) || (el.id && FORBIDDEN_ID.test(el.id))))
      .map(describe);
    const checkboxes = [...doc.querySelectorAll('input[type=checkbox]')]
      .filter((el) => visible(el))
      .map((el) => ({ id: el.id, name: el.name || null, checked: el.checked }));

    return { isEmpty, emptyMsg, rowCount: rows.length, rows: rows.slice(0, 40), deleteControls, checkboxes };
  }

  // Snapshot of whichever add-class screen we're on (recitation / preferences /
  // modal). Read-only. Reused by the enter: and prefs: captures.
  function captureScreen(doc) {
    const pick = (sel, extra = () => ({})) =>
      [...doc.querySelectorAll(sel)].slice(0, 30).map((el) => ({ ...describe(el), ...extra(el) }));
    return {
      screenTitle: norm((doc.getElementById("DERIVED_REGFRM1_TITLE1") || {}).textContent || ""),
      recitationSelects: pick('[id^="NYU_DERIVED_SR_ROW_STATUS"]', (el) => ({
        options: [...(el.options || [])].map((o) => ({ value: o.value, label: norm(o.textContent) })),
        onchange: el.getAttribute("onchange"),
      })),
      relateClassNbrs: pick('[id^="SSR_CLS_TBL_R1_RELATE_CLASS_NBR"]'),
      recitationRows: pick('[id^="SSR_CLS_TBL"][id*="_row_"]'),
      permissionInputs: pick('[id^="DERIVED_CLS_DTL_CLASS_PRMSN_NBR"]', (el) => ({
        maxLength: el.maxLength, onchange: el.getAttribute("onchange"),
      })),
      unitsGradingSelects: pick('select[id^="DERIVED_CLS_DTL"]', (el) => ({
        options: [...(el.options || [])].map((o) => ({ value: o.value, label: norm(o.textContent) })),
      })),
      nextButtons: pick('[id^="DERIVED_CLS_DTL_NEXT_PB"]'),
      cancelButtons: pick('[id^="DERIVED_CLS_DTL_CANCEL_PB"]'),
      waitlistControls: pick('[id*="WAIT" i]', (el) => ({ type: el.type || null, checked: el.checked })),
      // Waitlist opt-in could be a checkbox OR (on NYU's skin) a select, so grab
      // both, with the nearby label text to identify them.
      checkboxes: pick('input[type=checkbox], input[type=radio]', (el) => ({
        checked: el.checked, name: el.name || null,
        label: norm((el.closest("label") || (el.id && document.querySelector(`label[for="${el.id}"]`)) || {}).textContent || ""),
      })),
      allSelects: pick('select', (el) => ({
        options: [...(el.options || [])].map((o) => ({ value: o.value, label: norm(o.textContent) })),
      })),
      alertText: norm((doc.getElementById("ptModContent_0") || doc.getElementById("alertmsg") || {}).textContent || "").slice(0, 200),
      cancelPresent: !!doc.querySelector('[id^="DERIVED_CLS_DTL_CANCEL_PB"]'),
      newClickables: [...doc.querySelectorAll(CLICKABLE)].map(describe).filter((c) => c.visible && c.text).slice(0, 25),
      visibleText: norm(doc.body.innerText || "").slice(0, 600),
    };
  }

  // Walk up from the input until an ancestor contains something clickable that
  // ISN'T the input itself. (The class-number input carries an onclick, so it
  // matches CLICKABLE; without this filter the walk stops at depth 1 on the
  // input and never surfaces the Enter anchor two levels up.)
  function nearestClickables(input) {
    let cur = input.parentElement;
    for (let depth = 1; cur && depth <= 8; depth++, cur = cur.parentElement) {
      const found = [...cur.querySelectorAll(CLICKABLE)].filter((el) => el !== input);
      if (found.length) {
        return {
          depth,
          ancestor: cur.tagName.toLowerCase() + (cur.id ? "#" + cur.id : ""),
          items: found.slice(0, 15).map(describe),
        };
      }
    }
    return null;
  }

  function describeControl(doc) {
    const input = doc.getElementById(CLASS_NBR_ID);
    const all = [...doc.querySelectorAll(CLICKABLE)].map(describe);

    const idsByPrefix = {};
    for (const p of ID_PREFIXES) {
      const hits = [...doc.querySelectorAll(`[id^="${p}"]`)].map((el) => ({
        id: el.id, tag: el.tagName.toLowerCase(), text: norm(el.textContent).slice(0, 40),
      }));
      if (hits.length) idsByPrefix[p] = hits.slice(0, 40);
    }

    return {
      url: redact(doc.location.href),
      origin: doc.location.origin,
      // If this is relaxed (e.g. "nyu.edu"), that is WHY the top frame can
      // reach this document across origins. It is the load-bearing fact.
      documentDomain: doc.domain,
      isFluid: /_FL\b|_FL\./.test(doc.location.pathname + doc.location.search),
      bodyClass: (doc.body.className || "").slice(0, 140),
      hasWin0Form: !!doc.win0 || !!doc.querySelector("form[name=win0]"),

      input: { id: input.id, maxLength: input.maxLength, attrs: attrsOf(input) },
      inputAncestors: ancestorChain(input, 8),
      nearestClickables: nearestClickables(input),

      clickableCount: all.length,
      clickables: all.filter((c) => c.id || c.text).slice(0, 60),
      addCandidates: all.filter((c) => /^(enter|add|add class|search|go|next|»|>>)$/i.test(c.text)),
      forbidden: all.filter((c) => FORBIDDEN_TEXT.test(c.text) || (c.id && FORBIDDEN_ID.test(c.id))),

      // Where a result message could appear. #alertmsg does not exist at rest
      // on Fluid; modals are often rendered into a fresh iframe (#ptModFrame_N).
      messageContainers: [
        ...doc.querySelectorAll('[id*="alert" i], [id*="msg" i], [role="alertdialog"], [id^="ptMod"]'),
      ].slice(0, 20).map(describe),
      iframeCount: doc.querySelectorAll("iframe").length,

      idsByPrefix,
      netSoFar: netCount(doc.defaultView),
    };
  }

  // ---- frame reachability ----------------------------------------------------

  function collectDocs(doc, depth = 0, path = "top", out = []) {
    out.push({ doc, path, depth });
    if (depth >= 3) return out;
    for (const f of doc.querySelectorAll("iframe")) {
      let child = null;
      try { child = f.contentDocument; } catch { child = null; }
      const id = f.id || f.name || "(anon)";
      const p = `${path} > iframe#${id}`;
      if (child) collectDocs(child, depth + 1, p, out);
      else out.push({ doc: null, path: p, depth: depth + 1, blocked: true, src: f.src });
    }
    return out;
  }

  const findControl = (docs) =>
    docs.find((d) => d.doc && d.doc.getElementById(CLASS_NBR_ID)) || null;

  // The Albert frame regardless of which screen it's on. The add screen has the
  // class-number input; the recitation/preferences/waitlist screens do NOT
  // (that input is replaced), so identify the frame by its PeopleSoft win0 form
  // or the cart component URL. Used by cart/screen captures.
  const findAlbertDoc = (docs) =>
    findControl(docs) ||
    docs.find((d) => d.doc && (
      d.doc.querySelector('form[name="win0"]') ||
      /_SSENRL_CART_FL/i.test(d.doc.location.href)
    )) || null;

  // ---- the one opt-in action -------------------------------------------------

  async function submitTest(ctrl, iframeEl, action, onPhase = async () => {}) {
    const doc = ctrl.doc;
    const win = doc.defaultView;
    const input = doc.getElementById(CLASS_NBR_ID);

    const out = {
      action,
      drivenFrom: iframeEl ? "top frame via contentDocument" : "the control frame itself",
      framePath: ctrl.path,
      phase: "starting",
    };

    if (!action) {
      out.error =
        'no action set. Put "click:<elementId>" or "key:Enter" in the probe action box — ' +
        "this probe will not guess which control submits.";
      return out;
    }

    // BUTTON_SMALL is "Enter"; SMALL_BUTTON is "Search". The ids are
    // transpositions of each other and sit side by side. Any path that names a
    // control asserts its visible text before acting.
    const assertEnterId = (id, label) => {
      if (id === "BUTTON_SMALL" && !/^enter$/i.test(label)) {
        throw new Error(`#BUTTON_SMALL is labelled "${label}", not "Enter" — refusing`);
      }
    };

    let target = input;
    // "enter:<classNbr>" enters a REAL class through the bridge to capture the
    // recitation screen, then Cancels. "prefs:<classNbr>:<recNbr>" goes one
    // screen further: it also picks the named recitation to capture the
    // Enrollment Preferences screen, then Cancels. BOTH drive only Enter, the
    // recitation select, and Cancel — never Next/Proceed — so neither can add
    // anything to the cart.
    const isEnter = action.startsWith("enter:");
    const isPrefs = action.startsWith("prefs:");
    const isWl = action.startsWith("wl:");
    const isPerm = action.startsWith("perm:");
    const isBridge = action.startsWith("bridge:") || isEnter || isPrefs || isWl || isPerm;
    let enterValue = PROBE_NBR;
    let recPick = null;
    let permCode = null;

    if (isEnter || isPrefs || isWl || isPerm) {
      const parts = action.slice(action.indexOf(":") + 1).split(":").map((s) => s.trim());
      enterValue = parts[0];
      recPick = (isPrefs || isWl || isPerm) ? (parts[1] || null) : null;
      if (!/^\d{4,5}$/.test(enterValue)) {
        out.error = `expects a 4–5 digit class number, got "${enterValue}"`;
        return out;
      }
      if ((isPrefs || isWl) && !/^\d{4,5}$/.test(recPick || "")) {
        out.error = `needs a recitation class number, e.g. prefs:10603:10604 or wl:10612:10613`;
        return out;
      }
      if (isPerm) {
        // The code is NOT validated — feeding it garbage ("sdjksd") is the entire
        // point. The recitation is optional: blank means "this class has no
        // components, expect Enrollment Preferences straight after Enter".
        permCode = parts.slice(2).join(":");
        if (!permCode) {
          out.error = 'perm: needs a code to try, e.g. perm:10603:10604:sdjksd (or perm:10603::sdjksd for a class with no recitation)';
          return out;
        }
        if (recPick && !/^\d{4,5}$/.test(recPick)) {
          out.error = `recitation must be a 4–5 digit class number (or blank), got "${recPick}"`;
          return out;
        }
      }
      out.targetId = "BUTTON_SMALL";
      target = doc.getElementById("BUTTON_SMALL");
      if (!target) { out.error = "no BUTTON_SMALL (Enter) anchor on this page"; return out; }
      out.targetLabel = labelOf(target).slice(0, 60);
      try { assertEnterId("BUTTON_SMALL", out.targetLabel); } catch (e) { out.error = e.message; return out; }
    } else if (action.startsWith("click:") || action.startsWith("bridge:")) {
      const id = action.slice(action.indexOf(":") + 1).trim();
      target = doc.getElementById(id);
      if (!target) { out.error = `no element with id "${id}" in the control frame`; return out; }
      out.targetLabel = labelOf(target).slice(0, 60);
      out.targetId = id;
      try { assertEnterId(id, out.targetLabel); } catch (e) { out.error = e.message; return out; }
    } else if (action !== "key:Enter") {
      out.error = `unrecognized action "${action}"`;
      return out;
    }

    try { assertAllowed(target); } catch (e) { out.error = e.message; return out; }

    // The bridge handshake is a same-window post, so it only works from the
    // frame that natively owns the form. main() routes bridge actions here
    // in-frame; this guards against ever calling it via contentDocument.
    if (isBridge && win !== window) {
      out.error = "bridge action must run in the control frame itself, not via the top frame";
      return out;
    }

    // If the document is replaced, this token goes with it.
    const token = "stq-" + Math.random().toString(36).slice(2, 10);
    doc.documentElement.dataset.stqProbe = token;

    const netBefore = netCount(win);
    const iframesBefore = doc.querySelectorAll("iframe").length;
    const bodyLenBefore = doc.body.innerHTML.length;

    setNativeValue(input, enterValue);
    out.valueStuck = input.value === enterValue;

    if (isBridge) {
      // First prove the bridge is even installed. A ping touches no page code,
      // so if it times out we know MAIN-world injection was blocked (page CSP),
      // as opposed to "the call ran but the page didn't react".
      try {
        out.bridgePing = await bridgeCall("__ping", [], 4000);
        out.bridgeInstalled = true;
      } catch (e) {
        out.bridgeInstalled = false;
        out.error = "bridge.js is not answering in the MAIN world: " + e.message;
        out.phase = "done";
        out.isolatedWorldActionWorks = false;
        out.verdict = "MAIN-world injection appears blocked — check that bridge.js was injected " +
          "world:MAIN into this frame, and that the page CSP script-src whitelists the extension origin.";
        return out;
      }
      if (!out.bridgePing.hasSubmitFn) {
        out.error = "bridge installed but submitAction_win0 is not defined in the MAIN world";
        out.phase = "done";
        out.isolatedWorldActionWorks = false;
        return out;
      }
      try {
        out.bridgeReturn = await bridgeCall("submitAction_win0", ["document.win0", out.targetId]);
        out.bridgeReached = true;
      } catch (e) {
        out.bridgeReached = false;
        out.error = e.message;
        out.phase = "done";
        out.isolatedWorldActionWorks = false;
        out.verdict = "bridge refused the call: " + e.message;
        return out;
      }
    } else if (action === "key:Enter") {
      input.focus();
      for (const type of ["keydown", "keypress", "keyup"]) {
        input.dispatchEvent(new win.KeyboardEvent(type, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));
      }
    } else {
      target.click();
    }

    // Record the moment the action lands. The watch loop below runs for up to
    // 20s, and a report copied mid-loop used to show no `submit` key at all,
    // which reads as "nothing happened" when in fact it had barely begun.
    out.phase = isBridge ? "bridge call returned; watching for a response" : "clicked; watching for a response";
    out.clickedAt = Date.now();
    await onPhase(out);

    // A real reaction (navigation or PPR) shows up within a second or two — the
    // loop breaks the instant it does. This ceiling only bites the "nothing
    // happened" case, so keep it short enough not to feel like a hang.
    const deadline = Date.now() + 10000;
    let navigated = false, netFired = false, newIframe = false, domChanged = false;

    while (Date.now() < deadline) {
      await sleep(250);

      const live = iframeEl ? iframeEl.contentDocument === doc : doc.defaultView !== null;
      if (!live || doc.documentElement.dataset.stqProbe !== token) { navigated = true; break; }

      const n = netCount(win);
      if (netBefore != null && n != null && n > netBefore) netFired = true;
      if (doc.querySelectorAll("iframe").length > iframesBefore) newIframe = true;
      if (Math.abs(doc.body.innerHTML.length - bodyLenBefore) > 200) domChanged = true;

      if (netFired && (newIframe || domChanged)) break;
    }

    out.phase = "done";
    out.netFired = netFired;
    out.netDelta = netBefore == null ? null : (netCount(win) ?? "doc gone") - netBefore;
    out.documentReplaced = navigated;
    out.newIframeAppeared = newIframe;
    out.domChanged = domChanged;

    out.isolatedWorldActionWorks = !!(netFired || navigated || newIframe || domChanged);
    out.refreshMode = navigated ? "NAVIGATION (document replaced)"
      : netFired ? "PPR (partial refresh, document survived)"
      : "UNKNOWN — nothing observably happened";

    if (!out.isolatedWorldActionWorks) {
      out.verdict = "the action did not reach PeopleSoft. If this was a click on a " +
        "javascript: anchor, Blink evaluated it in the isolated world. Use bridge.js.";
      return out;
    }

    // Cancel backs us out cleanly (a submitAction_win0 anchor, so via the bridge).
    // We NEVER drive Next/Proceed here — capture only, no commit.
    // Idempotent: the early-return paths call it, and so does the finally below,
    // and a second Cancel from the add screen would report a misleading "no Cancel
    // button" over the real result.
    let cancelled = false;
    const cancelOut = async () => {
      if (cancelled) return out.backedOut;
      cancelled = true;
      const cancel = doc.querySelector('[id^="DERIVED_CLS_DTL_CANCEL_PB"]');
      if (cancel && /^cancel$/i.test(labelOf(cancel))) {
        try {
          await bridgeCall("submitAction_win0", ["document.win0", cancel.id]);
          return "clicked Cancel to return to the add screen";
        } catch (e) { return "could not Cancel: " + e.message; }
      }
      return "no Cancel button on this screen (likely an error modal, harmless)";
    };

    if (!navigated) {
      out.afterState = captureScreen(doc);
      out.afterState.messageContainers = [
        ...doc.querySelectorAll('[id*="alert" i], [id*="msg" i], [role="alertdialog"], [id^="ptMod"]'),
      ].slice(0, 20).map(describe);

      // Anything that throws below (a bad selector, a screen we didn't expect)
      // used to escape all the way to main(), so the run left Albert parked on a
      // half-finished class detail screen AND recorded no report — the two things
      // that make a failed probe expensive. Catch it, keep the partial capture,
      // and always Cancel back to the add screen in the finally.
      try {

      // prefs:/wl: go deeper — pick the named recitation (its select
      // self-submits), which reveals the Next button. prefs: captures there.
      // wl: clicks Next ONCE more to reach the Enrollment Preferences screen
      // (where a full class shows the waitlist opt-in) and captures that. Neither
      // clicks the commit Next on the preferences screen — both Cancel out.
      if (isPrefs || isWl || isPerm) {
        const relateRows = [...doc.querySelectorAll('[id^="SSR_CLS_TBL_R1_RELATE_CLASS_NBR"]')];

        // A class with no components goes straight from Enter to Enrollment
        // Preferences — there is no recitation screen to act on. Only perm: is
        // allowed to skip it (prefs:/wl: are *about* the recitation screen).
        const skipRecitation = isPerm && !relateRows.length;
        if (skipRecitation) {
          out.recitationSkipped = "no recitation rows on this screen — the class has no components, so Enter went straight to the class detail";
        }

        if (!skipRecitation) {
          let relate = recPick ? relateRows.find((el) => norm(el.textContent) === recPick) : null;
          // For a waitlist or permission capture the exact recitation is
          // irrelevant — any valid one reaches the screen we want — so fall back
          // to the first offered rather than failing the capture.
          if (!relate && (isWl || isPerm) && relateRows.length) {
            relate = relateRows[0];
            out.recitationFallback = recPick
              ? `${recPick} not offered; used first offered (${norm(relate.textContent)})`
              : `no recitation named; used first offered (${norm(relate.textContent)})`;
          }
          if (!relate) {
            out.prefsError = `recitation ${recPick} is not offered on the screen ` +
              `(offered: ${relateRows.map((r) => norm(r.textContent)).join(", ") || "none"})`;
            out.backedOut = await cancelOut();
            return out;
          }
          const idx = (relate.id.match(/\$(\d+)$/) || [])[1];
          const sel = doc.getElementById(`NYU_DERIVED_SR_ROW_STATUS$${idx}`);
          if (!sel) {
            out.prefsError = `no NYU_DERIVED_SR_ROW_STATUS$${idx} select for recitation ${recPick}`;
            out.backedOut = await cancelOut();
            return out;
          }
          setNativeValue(sel, "Y");
          try {
            await bridgeCall("submitAction_win0", ["document.win0", sel.id]);
            out.recitationPicked = `${norm(relate.textContent)} (row $${idx})`;
          } catch (e) {
            out.prefsError = "could not submit recitation: " + e.message;
            out.backedOut = await cancelOut();
            return out;
          }
          // Wait for the Next button to appear after picking.
          await waitFor(() => doc.querySelector('a[id^="DERIVED_CLS_DTL_NEXT_PB"]'), 8000);
        }
        out.prefsScreen = captureScreen(doc);

        // Is the permission field on screen? That field only exists on Enrollment
        // Preferences — and on THAT screen, Next is the COMMIT. So this doubles as
        // "are we already past the recitation screen", and as the guard that stops
        // us clicking a commit Next before the code we came here to test is typed.
        //
        // `input[...]`, NOT `[...]`: PeopleSoft gives the label, the wrapper and
        // the field ids sharing one prefix (DERIVED_..._NBR, ..._NBR_LBL, ...$span),
        // and the label comes FIRST in document order. A tag-less selector returns
        // the label — which is how v2.4.1 crashed with "Illegal invocation" trying
        // to set .value on it. Always name the tag on a PeopleSoft id prefix.
        const permField = () =>
          [...doc.querySelectorAll('input[id^="DERIVED_CLS_DTL_CLASS_PRMSN_NBR"]')].find(visible) || null;
        const atPrefs = () => !!permField();

        const clickNext = async (where) => {
          const nextA = [...doc.querySelectorAll('a[id^="DERIVED_CLS_DTL_NEXT_PB"]')]
            .find((a) => /^next$/i.test(labelOf(a)));
          if (!nextA) return { error: `no Next button on the ${where} screen` };
          try { assertAllowed(nextA); } catch (e) { return { error: e.message }; }   // belt: never a forbidden control
          try {
            await bridgeCall("submitAction_win0", ["document.win0", nextA.id]);
            return { id: nextA.id };
          } catch (e) { return { error: "could not click Next: " + e.message }; }
        };

        // wl:/perm: one more Next → the Enrollment Preferences screen. Skipped if
        // we are already standing on it (a class with no components after Enter).
        if ((isWl || isPerm) && !atPrefs()) {
          const n = await clickNext("recitation");
          if (n.error) { out[isWl ? "wlError" : "permError"] = n.error; }
          else {
            out.nextClicked = n.id;
            // Wait for the next screen (preferences, or a result modal).
            await waitFor(() =>
              doc.getElementById("ptModContent_0") ||
              atPrefs() ||
              doc.querySelector('input[type=checkbox]') ||
              norm((doc.getElementById("DERIVED_REGFRM1_TITLE1") || {}).textContent || "") !== out.prefsScreen.screenTitle,
              10000);
            out.waitlistScreen = captureScreen(doc);
            out.waitlistScreen.modalText = norm((doc.getElementById("ptModContent_0") || {}).textContent || "").slice(0, 200);
          }
        }

        // ---- perm: type the code and drive the commit Next -------------------
        //
        // This is the only way to see Albert reject a permission code: the error
        // exists only as the server's reply to this submit. Captured at two points
        // because a bad code can fail in two different places — see the header.
        if (isPerm && !out.permError) {
          const perm = permField();
          if (!perm) {
            out.permError = "no permission field on this screen — this class may not offer one. " +
              "Screen captured anyway (see waitlistScreen/prefsScreen).";
            out.backedOut = await cancelOut();
            return out;
          }

          out.permField = {
            id: perm.id,
            maxLength: perm.maxLength,
            valueBefore: perm.value,          // should be "" on a fresh class
            onchange: perm.getAttribute("onchange"),   // the numeric doEdits regex lives here
          };
          out.messageBeforeTyping = messageText(doc);

          // (a) CLIENT-side: the field's onchange runs PeopleSoft's doEdits numeric
          //     check. A non-numeric code may be refused right here, with no submit.
          out.codeTried = permCode;
          setNativeValue(perm, permCode);
          await sleep(600);
          out.afterTypingCode = {
            valueStuck: perm.value === permCode,
            valueNow: perm.value,
            message: messageText(doc),
            note: "if `message` is set here, PeopleSoft rejected the code CLIENT-side (doEdits), before any submit",
          };

          // (b) SERVER-side: drive Next. If the code is accepted the class lands in
          //     the CART (recoverable — Clear Albert's cart; it never enrolls).
          const n = await clickNext("Enrollment Preferences");
          if (n.error) {
            out.permError = n.error;
          } else {
            out.commitNextClicked = n.id;
            await waitFor(() => messageText(doc), 12000);
            const msg = messageText(doc);
            out.afterNext = {
              message: msg,
              screen: captureScreen(doc),
              // THE ANSWER. Copy `message.exact` into recon-findings.md verbatim.
              verdict: !msg ? "no message appeared — capture the screen and look at it by hand"
                : /has been added to your Shopping Cart/i.test(msg.text)
                  ? "ACCEPTED — Albert took the code and CARTED the class. Run Clear Albert's cart."
                  : "REJECTED — this is Albert's wording for a bad permission code.",
            };
            out.landedInCart = !!msg && /has been added to your Shopping Cart/i.test(msg.text);

            // Dismiss the modal (#ICOK's action is in onclick, so a synthetic click).
            const ok = doc.querySelector('[id="#ICOK"]');
            if (ok) { try { ok.click(); } catch { /* ignore */ } await sleep(800); }
            out.modalDismissed = !messageText(doc);
          }
        }
      }

      } catch (e) {
        out.crashed = e.message;
        out.crashStack = (e.stack || "").split("\n").slice(1, 4).map((l) => l.trim());
      } finally {
        if (isEnter || isPrefs || isWl || isPerm) out.backedOut = await cancelOut();
      }
    }
    return out;
  }

  // ---- report ----------------------------------------------------------------

  async function record(patch) {
    for (let i = 0; i < 3; i++) {
      const { stq_probe = {} } = await chrome.storage.local.get("stq_probe");
      const next = { ...stq_probe, at: Date.now(), ...patch };
      await chrome.storage.local.set({ stq_probe: next });
      await sleep(30 + Math.random() * 70);
      const { stq_probe: check } = await chrome.storage.local.get("stq_probe");
      if (JSON.stringify(check) === JSON.stringify(next)) return;
    }
  }

  async function main() {
    const {
      stq_probe_mode: mode = "read",
      stq_probe_action: rawAction = "",
    } = await chrome.storage.local.get(["stq_probe_mode", "stq_probe_action"]);
    const action = rawAction.trim();

    const ownsInput = !!document.getElementById(CLASS_NBR_ID);
    // bridge:, enter:, prefs:, wl: and perm: all use the same-window bridge
    // handshake, so they must run in the control frame in-frame.
    const bridgeSubmit = mode === "submit" && /^(bridge|enter|prefs|wl|perm):/.test(action);

    // ---- the top frame: ALWAYS records a baseline map ------------------------
    // This runs every time, even when no frame has the input, so a run is never
    // silent — the report always tells you what was (or wasn't) on the page.
    if (window === window.top) {
      const docs = collectDocs(document);
      const ctrl = findControl(docs);            // add screen only
      const albert = findAlbertDoc(docs);        // any Albert screen

      await record({
        mode,
        action,
        topUrl: redact(location.href),
        topDocumentDomain: document.domain,
        frameCount: docs.length,
        frames: docs.map((d) => ({
          path: d.path,
          depth: d.depth,
          reachable: !!d.doc,
          origin: d.doc ? d.doc.location.origin : null,
          sameOriginAsTop: d.doc ? d.doc.location.origin === location.origin : null,
          src: redact(d.src || (d.doc && d.doc.location.href) || ""),
          hasClassNbrInput: !!(d.doc && d.doc.getElementById(CLASS_NBR_ID)),
        })),
        controlReachableFromTop: !!ctrl,
        controlFramePath: ctrl ? ctrl.path : null,
        control: ctrl ? describeControl(ctrl.doc) : null,
        albertFramePath: albert ? albert.path : null,
        note: ctrl ? undefined
          : albert ? "Albert is on a class-detail screen (no add-classes input here)."
          : "No Albert frame found. Open Albert's 'Add Classes' page and let it load, then probe again.",
      });

      if (mode === "cart") {
        await record({ cart: albert ? describeCart(albert.doc) : { isEmpty: null, note: "no Albert frame found" } });
      }

      // Read-only dump of whatever class-detail screen the user is currently on
      // (they navigate by hand; we never click). This is how we capture the
      // waitlist screen without any risk of committing a class.
      if (mode === "screen") {
        await record({ screen: albert ? captureScreen(albert.doc) : { note: "no Albert frame found" } });
      }

      if (mode === "submit") {
        if (!ctrl) {
          await record({ submit: {
            action, phase: "done", isolatedWorldActionWorks: false,
            error: "no add-class form found on this page — is it fully loaded?",
          } });
        } else if (bridgeSubmit) {
          // Same-window handshake: only the control frame can run it. If the
          // control IS this top frame (the mock), do it here; otherwise the
          // control subframe's own instance handles and records it.
          if (ctrl.depth === 0) {
            await record({ submit: await submitTest(ctrl, null, action, (p) => record({ submit: p })) });
          }
        } else {
          const iframeEl = ctrl.depth === 0 ? null :
            [...document.querySelectorAll("iframe")].find((f) => {
              try { return f.contentDocument === ctrl.doc; } catch { return false; }
            }) || null;
          await record({ submit: await submitTest(ctrl, iframeEl, action, (p) => record({ submit: p })) });
        }
      }
      return;
    }

    // ---- a subframe ----------------------------------------------------------
    // The control frame runs the bridge submit in-frame (same-window handshake).
    if (bridgeSubmit && ownsInput) {
      await record({
        submit: await submitTest(
          { doc: document, path: "control frame (in-frame)" }, null, action,
          (partial) => record({ submit: partial })
        ),
      });
      return;
    }

    // Non-bridge fallback: only matters if the top frame could not reach the
    // control (deep/cross-origin frame). Otherwise the top frame has it covered.
    await sleep(1500);
    const { stq_probe = {} } = await chrome.storage.local.get("stq_probe");
    if (stq_probe.controlReachableFromTop) return;
    if (!ownsInput) return;
    await record({
      control: describeControl(document),
      note: "top frame could not reach the controls; this subframe reported instead",
    });
    if (mode === "submit" && !bridgeSubmit) {
      await record({ submit: await submitTest({ doc: document, path: "self" }, null, action,
        (partial) => record({ submit: partial })) });
    }
  }

  main()
    .catch((e) => record({ crashed: e.message, stack: (e.stack || "").split("\n").slice(0, 4) }))
    .finally(() => { window.__STQ_PROBE_RUNNING__ = false; });
})();
