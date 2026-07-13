// popup.js — UI for Relativity's class queue.
//
// Storage keys (chrome.storage.local):
//   stq_queue    : array of class entries (built by einstein.js)
//   stq_status   : { [index]: { state, message, log } }  queued|working|in-cart|failed|stopped
//   stq_import   : { ok, count, semester, errors[], at } — last Einstein import summary
//   stq_run      : { state, message, at } — last Fill / Clear-cart run
//   stq_run_mode : "fill" | "clearcart" — which flow albert.js should execute

const $ = (sel) => document.querySelector(sel);

const els = {
  import: $("#btnImport"),
  importMsg: $("#importMsg"),
  queueSec: $("#queueSec"),
  queueList: $("#queueList"),
  clear: $("#btnClear"),
  fill: $("#btnFill"),
  fillMsg: $("#fillMsg"),
  clearCart: $("#btnClearCart"),
  clearCartMsg: $("#clearCartMsg"),
  ver: $("#ver"),
};

// Pages each button is allowed to act on.
const EINSTEIN_URL = /einsteinnyu\.com/i;
const ALBERT_URL = /nyu\.edu/i;

// Everything a run leaves behind. Import wipes all of it (it's the start button).
// The stq_probe_* keys outlive the Developer section that wrote them (removed in
// v2.6.0): anyone who ran the probe in v2.4/v2.5 still has a report sitting in
// storage, and this is what clears it. probe.js itself is still in the extension.
const RUN_KEYS = [
  "stq_queue", "stq_status", "stq_import", "stq_run", "stq_run_mode", "stq_cart_debug",
  "stq_probe", "stq_probe_mode", "stq_probe_action",
];

async function getState() {
  const s = await chrome.storage.local.get(["stq_queue", "stq_status", "stq_import", "stq_run"]);
  return {
    queue: s.stq_queue || [],
    status: s.stq_status || {},
    imp: s.stq_import || null,
    run: s.stq_run || null,
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showMsg(el, text, kind) {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
  el.hidden = !text;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// Einstein stores the term as "2026fall". Show it the human way, "Fall 2026",
// for any term/year. Unknown shapes pass through unchanged rather than mangled.
const SEASONS = {
  spring: "Spring", summer: "Summer", fall: "Fall", autumn: "Fall",
  winter: "Winter", january: "January", "j-term": "J-Term", jterm: "J-Term",
};
function formatSemester(s) {
  if (!s) return "?";
  const str = String(s).toLowerCase();
  const year = (str.match(/(?:19|20)\d{2}/) || [])[0];
  const seasonKey = Object.keys(SEASONS).find((k) => str.includes(k));
  return seasonKey && year ? `${SEASONS[seasonKey]} ${year}` : String(s);
}

// Entries imported from Einstein carry `components`. Manual paste entries (and
// anything stored before that field existed) only have the flat fields, so
// rebuild a one-component list from those.
function componentsOf(e) {
  if (Array.isArray(e.components) && e.components.length) return e.components;
  const out = [];
  if (e.classNbr || e.lectureSection) {
    out.push({
      type: e.lectureSection ? "Lecture" : "Class",
      section: e.lectureSection || null,
      classNbr: e.classNbr || null,
      status: null,
    });
  }
  if (e.recitationClassNbr || e.recitationSection) {
    out.push({
      type: "Recitation",
      section: e.recitationSection || null,
      classNbr: e.recitationClassNbr || null,
      status: null,
    });
  }
  return out;
}

// Human status labels for the queue chip, Title Cased.
const STATE_LABELS = {
  queued: "In Queue", working: "Working", "in-cart": "In Cart",
  failed: "Failed", stopped: "Stopped",
};
const stateLabel = (s) => STATE_LABELS[s] || s.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Section status → colour class: open (green), waitlist (yellow), else (red).
function statusClass(status) {
  if (!status || /^open$/i.test(status)) return "open";
  if (/wait\s*list/i.test(status)) return "wl";
  return "shut";
}

function componentRow(c) {
  return `
    <li class="comp">
      <span class="ctype">${esc(c.type)}</span>
      <span class="csec">${c.section ? esc(c.section) : "&mdash;"}</span>
      <span class="cnbr">${c.classNbr ? "#" + esc(c.classNbr) : "no class nbr"}</span>
      <span class="cstat ${statusClass(c.status)}">${c.status ? esc(c.status) : ""}</span>
    </li>`;
}

// A warning is a one-liner. Anything longer is prose and belongs behind the
// disclosure — queues written by older versions stored `notes` in `warnings`,
// and nothing should be able to turn a card back into a wall of text.
const WARN_MAX = 120;
const shortWarnings = (e) => (e.warnings || []).filter((w) => w.length <= WARN_MAX);

// Long registration prose from Einstein's `notes` — collapsed, never inline.
function restrictionsBlock(e) {
  const r = [
    ...(e.restrictions || []),
    ...(e.warnings || [])
      .filter((w) => w.length > WARN_MAX)
      .map((w) => ({ label: "Note", text: w })),
  ];
  if (!r.length) return "";
  return `
    <details class="restr">
      <summary>Registration restrictions (${r.length})</summary>
      ${r.map((x) => `<p><b>${esc(x.label)}</b> ${esc(x.text)}</p>`).join("")}
    </details>`;
}

// Which cards the user has expanded this session. Everything starts collapsed —
// a failure shows its error inline (outside the disclosure), so there's never a
// reason to auto-expand the full detail.
const toggled = new Map();
const isOpen = (i) => toggled.get(i) === true;

function render(queue, status) {
  els.queueSec.hidden = queue.length === 0;
  els.fill.disabled = queue.length === 0 || !queue.some((e) => e.classNbr);

  // Toggling waitlist writes to storage, which re-renders this list — which would
  // rebuild the button under a keyboard user's feet. Remember who had focus.
  const active = document.activeElement;
  const refocus = active && active.classList && active.classList.contains("wl-toggle")
    ? active.dataset.i : null;

  els.queueList.innerHTML = queue
    .map((e, i) => {
      const st = status[i] || { state: "queued", message: "" };
      const open = isOpen(i);
      const failed = st.state === "failed" && st.message;
      const comps = componentsOf(e);
      const warns = shortWarnings(e)
        .map((w) => `<div class="warn">&#9888; ${esc(w)}</div>`)
        .join("");
      return `
      <li class="cls${open ? " open" : ""}${failed ? " is-failed" : ""}">
        <div class="cls-head" data-toggle="${i}" role="button" tabindex="0"
             aria-expanded="${open}" title="${open ? "Hide details" : "Show details"}">
          <span class="chev" aria-hidden="true"></span>
          <span class="code">${esc(e.courseCode || "Class #" + e.classNbr)}</span>
          <span class="chip ${st.state}">${esc(stateLabel(st.state))}</span>
        </div>

        <div class="cls-quick">
          <label class="perm-l">Permission Code
            <input class="perm" data-i="${i}" value="${esc(e.permissionNbr)}"
                   placeholder="Optional" maxlength="6" inputmode="numeric">
          </label>
          <button type="button" class="wl-toggle" data-i="${i}"
                  aria-pressed="${e.waitlistOk ? "true" : "false"}"
                  aria-label="Waitlist if full">
            <span class="wl-box">
              <svg class="wl-check" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.4 6.3 4.7 8.6 9.6 3.7" fill="none" stroke="currentColor"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span>Waitlist if full</span>
          </button>
        </div>

        ${failed ? `
        <div class="err" role="alert">
          <div class="err-head"><span class="err-icon">&#9888;</span> Couldn&rsquo;t add this class</div>
          <div class="err-body">${esc(st.message)}</div>
        </div>` : ""}

        <div class="cls-detail">
          ${e.title ? `<div class="title">${esc(e.title)}</div>` : ""}
          <ul class="comps">${comps.map(componentRow).join("")}</ul>
          ${warns}
          ${restrictionsBlock(e)}
          ${!failed && st.message ? `<div class="status-msg">${esc(st.message)}</div>` : ""}
        </div>
      </li>`;
    })
    .join("");

  if (refocus != null && els.queueList.querySelector) {
    const back = els.queueList.querySelector(`.wl-toggle[data-i="${refocus}"]`);
    if (back) back.focus();
  }
}

async function refresh() {
  const { queue, status, imp, run } = await getState();
  render(queue, status);

  if (run) {
    const { stq_run_mode } = await chrome.storage.local.get("stq_run_mode");
    const target = stq_run_mode === "clearcart" ? els.clearCartMsg : els.fillMsg;
    const bad = run.state === "blocked" || run.state === "stopped" || run.state === "error";
    showMsg(target, run.message, bad ? "error" : run.state === "done" ? "ok" : null);
  }

  if (imp && !imp.ok) {
    showMsg(els.importMsg, imp.errors.join(" — "), "error");
  } else if (imp && imp.ok) {
    const errs = imp.errors.length ? ` (${imp.errors.length} problem(s): ${imp.errors.join("; ")})` : "";
    showMsg(els.importMsg, `Imported ${imp.count} class(es) for ${formatSemester(imp.semester)}${errs}`, imp.errors.length ? "error" : "ok");
  }
}

// --- Import from Einstein ---------------------------------------------------
//
// This is the START button. It wipes every trace of the previous session — the
// old queue, per-class statuses, and the leftover run messages ("Done. 3 in
// cart", "Cart cleared — removed 5") — so a fresh import never shows stale
// results next to new classes.

async function resetAll() {
  await chrome.storage.local.remove(RUN_KEYS);
  toggled.clear();                      // card expand/collapse state
  showMsg(els.importMsg, "");
  showMsg(els.fillMsg, "");
  showMsg(els.clearCartMsg, "");
  render([], {});                       // blank the list immediately
}

els.import.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !EINSTEIN_URL.test(tab.url || "")) {
    showMsg(els.importMsg, "Open your Einstein schedule tab first, then click Import.", "error");
    return;
  }
  await resetAll();
  showMsg(els.importMsg, "Importing…");
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["einstein.js"] });
    // einstein.js reports back through stq_import / stq_queue; storage.onChanged re-renders.
  } catch (err) {
    showMsg(els.importMsg, "Could not run importer: " + err.message, "error");
  }
});

// --- Per-class options ----------------------------------------------------

// Albert's permission field is a NUMBER field: up to 6 digits, no sign, no
// decimals (its own doEdits regex, captured live: /^ *[0-9\,]*(\.[0-9\,]*)? *$/).
// Anything else is refused at the very last step with a format error — after the
// class has been opened and its recitation picked. That is the only thing Albert
// actually rejects, so keep non-digits out of the box and the error can't happen.
els.queueList.addEventListener("input", (ev) => {
  const t = ev.target;
  if (!t.classList || !t.classList.contains("perm")) return;
  const digits = t.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== t.value) {
    const atEnd = t.selectionStart === t.value.length;
    t.value = digits;
    if (atEnd) t.setSelectionRange(digits.length, digits.length);
  }
});

// Permission code edits (an <input>, fires change).
els.queueList.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (!t.classList.contains("perm")) return;
  const i = Number(t.dataset.i);
  if (Number.isNaN(i)) return;
  const { queue } = await getState();
  if (!queue[i]) return;
  queue[i].permissionNbr = t.value.replace(/\D/g, "").slice(0, 6);
  await chrome.storage.local.set({ stq_queue: queue });
});

els.queueList.addEventListener("click", async (ev) => {
  // Expand / collapse a class card.
  const head = ev.target.closest(".cls-head");
  if (head) {
    const i = Number(head.dataset.toggle);
    if (Number.isNaN(i)) return;
    toggled.set(i, !isOpen(i));
    refresh();
    return;
  }

  // "Waitlist if full" toggle. This flips aria-pressed and persists the state —
  // nothing else. All the on/off appearance is CSS hanging off [aria-pressed].
  const btn = ev.target.closest(".wl-toggle");
  if (!btn) return;
  const i = Number(btn.dataset.i);
  if (Number.isNaN(i)) return;
  const { queue } = await getState();
  if (!queue[i]) return;

  const on = !queue[i].waitlistOk;
  btn.setAttribute("aria-pressed", on ? "true" : "false"); // instant, no re-render
  queue[i].waitlistOk = on;
  await chrome.storage.local.set({ stq_queue: queue });    // storage.onChanged re-renders
});

// Keyboard: Enter/Space on a card header toggles it, like a real disclosure.
els.queueList.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const head = ev.target.closest(".cls-head");
  if (!head) return;
  ev.preventDefault();
  head.click();
});

// --- Clear ------------------------------------------------------------------

els.clear.addEventListener("click", async () => {
  await resetAll();
  refresh();
});

// --- Fill Albert's cart -----------------------------------------------------

els.fill.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !ALBERT_URL.test(tab.url || "")) {
    showMsg(els.fillMsg, "Open Albert's Add Classes page (or the mock) first.", "error");
    return;
  }
  const { queue, status } = await getState();
  // Keep classes already in the cart; requeue everything else.
  const fresh = {};
  queue.forEach((_, i) => {
    fresh[i] = status[i]?.state === "in-cart" ? status[i] : { state: "queued", message: "" };
  });
  await chrome.storage.local.set({ stq_status: fresh, stq_run_mode: "fill" });
  await chrome.storage.local.remove("stq_run");
  showMsg(els.fillMsg, "Running… watch statuses above.");
  try {
    // The bridge (MAIN world) must be resident before albert.js (isolated) runs,
    // in every frame, so the control frame's automation can call submitAction_win0.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      files: ["bridge.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["albert.js"],
    });
  } catch (err) {
    showMsg(els.fillMsg, "Could not inject: " + err.message, "error");
    return;
  }
  // A run that reports nothing at all means every frame bailed out. Say so
  // instead of leaving "Running…" on screen forever.
  setTimeout(async () => {
    const { stq_run } = await chrome.storage.local.get("stq_run");
    if (!stq_run) {
      showMsg(els.fillMsg,
        "Injected, but no frame found an add-class form. Are you on Albert's Add Classes page?",
        "error");
    }
  }, 3000);
});

// --- Clear Albert's cart ----------------------------------------------------
//
// Deletes every class from the cart, via the same bridge as Fill. albert.js
// discovers the delete controls at runtime and confirms the "are you sure?"
// modal; if it can't find them it captures the cart page to stq_cart_debug.
// Deleting from the cart is reversible and never enrolls.

els.clearCart.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !ALBERT_URL.test(tab.url || "")) {
    showMsg(els.clearCartMsg, "Open Albert's shopping cart page first.", "error");
    return;
  }
  if (!confirm("Delete ALL classes from your Albert shopping cart? (You can re-add them; this never enrolls.)")) return;
  await chrome.storage.local.set({ stq_run_mode: "clearcart" });
  await chrome.storage.local.remove("stq_run");
  showMsg(els.clearCartMsg, "Clearing your Albert cart…");
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["bridge.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ["albert.js"],
    });
  } catch (err) {
    showMsg(els.clearCartMsg, "Could not run: " + err.message, "error");
    return;
  }
  setTimeout(async () => {
    const { stq_run } = await chrome.storage.local.get("stq_run");
    if (!stq_run) showMsg(els.clearCartMsg, "No response — are you on Albert's Add Classes / cart page?", "error");
  }, 4000);
});


// --- Live updates -----------------------------------------------------------

// Shown in the header so "am I running the code I just edited?" is answerable
// at a glance, without digging through chrome://extensions.
const ver = chrome.runtime?.getManifest?.().version;
if (ver && els.ver) els.ver.textContent = "v" + ver;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stq_queue || changes.stq_status || changes.stq_import || changes.stq_run) refresh();
});

refresh();
