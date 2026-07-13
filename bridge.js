// bridge.js — MAIN-world escape hatch.
//
// The probe proved it: a content script's isolated-world anchor.click() does
// NOT run Albert's `javascript:submitAction_win0(...)` href — Blink evaluates
// it in the isolated world, where that function is undefined, and nothing
// happens. So the isolated world hands the call to this file, which runs in the
// page's own MAIN world where submitAction_win0 exists, and calls it by name.
//
// Injected with chrome.scripting.executeScript({ world: "MAIN", allFrames:true }).
// It has no chrome.* access, so it is inert until the isolated world messages it.
//
// Channel: window.postMessage, NOT CustomEvent. A CustomEvent's `detail` set in
// one world reads back as null in the other; postMessage structured-clones its
// payload across the isolated↔MAIN boundary, and both worlds share the frame's
// window so a same-window post is heard on both sides.
//
//   isolated → MAIN   { __stqBridge:"call",   id, fn, args }
//   MAIN → isolated   { __stqBridge:"result", id, ok, value?, error? }
//
// ============================ HARD STOP ===================================
// This is the one place that can call arbitrary page code, so the allowlist IS
// the safety boundary. It refuses any function not named below, and any
// argument naming an enroll/validate/finish/proceed control. Do not widen
// ALLOWED_FNS or loosen FORBIDDEN_ARG without re-reading the safety rules in
// CLAUDE.md — this file is how the extension could enroll you by accident.
// ==========================================================================

(() => {
  if (window.__STQ_BRIDGE_INSTALLED__) return;
  window.__STQ_BRIDGE_INSTALLED__ = true;

  const ALLOWED_FNS = new Set(["submitAction_win0"]);

  // Controls that advance toward enrolling, by id or label fragment. Mirrors
  // probe.js / albert.js FORBIDDEN_ID so the block holds even if a caller slips.
  const FORBIDDEN_ARG =
    /enroll|validate|finish|proceed|submit_?pb|ssr_pb_submit|link_add_enrl|step[23]/i;

  function invoke(fn, args) {
    if (!ALLOWED_FNS.has(fn)) throw new Error(`bridge: '${fn}' is not allowlisted`);
    if (typeof window[fn] !== "function") throw new Error(`bridge: page has no ${fn}()`);

    for (const a of args) {
      if (typeof a === "string" && FORBIDDEN_ARG.test(a)) {
        throw new Error(`HARD STOP: bridge refusing argument "${String(a).slice(0, 60)}"`);
      }
    }

    // submitAction_win0(form, controlId): the form is a live DOM node and can't
    // cross the message boundary, so the caller sends the literal string
    // "document.win0" and we resolve it here, in the world that owns it.
    const resolved = args.map((a) => (a === "document.win0" ? document.win0 : a));
    if (resolved.some((a) => a === undefined)) {
      throw new Error("bridge: could not resolve a DOM argument (document.win0 missing?)");
    }
    const ret = window[fn](...resolved);
    return typeof ret === "object" && ret !== null ? "[object]" : ret;
  }

  window.addEventListener("message", (ev) => {
    // Same-window only. ev.source is the window itself for a same-window post;
    // this rejects anything arriving from another frame.
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.__stqBridge !== "call") return;

    // "__ping" proves the bridge installed WITHOUT touching page code, so the
    // caller can tell "MAIN injection was blocked" from "call ran, page didn't
    // change". It also reports whether the form and submit function are present.
    if (msg.fn === "__ping") {
      window.postMessage({
        __stqBridge: "result", id: msg.id, ok: true,
        value: { pong: true, hasWin0: !!document.win0, hasSubmitFn: typeof window.submitAction_win0 === "function" },
      }, window.location.origin);
      return;
    }

    let reply;
    try {
      reply = { __stqBridge: "result", id: msg.id, ok: true, value: invoke(msg.fn, msg.args || []) };
    } catch (e) {
      reply = { __stqBridge: "result", id: msg.id, ok: false, error: e.message };
    }
    window.postMessage(reply, window.location.origin);
  });

  // Announce readiness so a caller that attached late can still tell the bridge
  // is present (it also just retries with a timeout).
  window.postMessage({ __stqBridge: "result", id: "ready", ok: true }, window.location.origin);
})();
