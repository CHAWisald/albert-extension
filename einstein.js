// einstein.js — injected into the EinsteinNYU tab when the user clicks
// "Import schedule from Einstein" in the popup.
//
// What it does:
//   1. Reads the planned schedule from localStorage key `needCart`. Each entry
//      carries the course's FULL section list; the sections the student picked
//      are flagged `enabled: true`. That is the whole source of truth for the
//      picks — no network call is needed to learn them. (Verified against a
//      real schedule: MATH-UA 325 → 10612 Lecture "010" + 10613 Recitation
//      "011" enabled, the other ten sections not.)
//   2. Einstein's section_id IS Albert's class number (confirmed), so the
//      class numbers fall straight out of step 1.
//   3. Optionally re-fetches each chosen section from Einstein's Supabase API
//      to refresh live `status`/`notes`, because needCart's copy goes stale.
//      This is best-effort: if the key is missing or the call fails, the import
//      still succeeds with Einstein's cached status and a warning.
//   4. Surfaces `status` (Closed / Wait List) and `notes` as pre-flight
//      warnings, and writes the queue to chrome.storage.local (stq_queue) plus
//      an import summary (stq_import). The popup renders both.
//
// Mock hook: if the page contains <script type="application/json"
// id="stq-mock-sections">, its JSON ({ course_id: [sections...] }) is used
// instead of the network — that's how test-einstein.html works offline.

(() => {
  if (window.__STQ_EINSTEIN_RUNNING__) return;
  window.__STQ_EINSTEIN_RUNNING__ = true;

  const CONFIG = {
    // Base URL of Einstein's REST API — a Supabase project, so
    // "https://<ref>.supabase.co/rest/v1". Left "" to auto-discover from the
    // page's own network requests.
    apiBase: "",
    // Supabase's *project* anon key, required in an `apikey` header — a session
    // cookie is not enough, which is what the 401s were. It is public: Einstein
    // ships it to every browser that loads the site, and row-level security is
    // what actually protects the data. We still discover it at runtime rather
    // than pinning it, because projects rotate keys.
    apiKey: "",
    // Picks come from needCart. This only re-checks each chosen section's live
    // `status`/`notes`, since Einstein's cache can be stale by enrollment day.
    // Turning it off makes the importer fully offline.
    refreshStatus: true,
    // Be gentle with Einstein's API: pause between course lookups.
    delayBetweenCoursesMs: 400,
    mockSelector: "#stq-mock-sections",
    // Cap on how much bundle text we'll read while hunting for the key.
    maxScriptBytes: 6_000_000,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function readMockSections() {
    const el = document.querySelector(CONFIG.mockSelector);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  // Einstein's frontend already talked to its API while loading the page;
  // its requests are visible in the resource timing log, so we can recover
  // the base URL without hardcoding it.
  function discoverApiBase() {
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const m =
          entry.name.match(/^(https?:\/\/[^/]+\/rest\/v\d+)\//) ||
          entry.name.match(/^(.*)\/(?:sections|courses)\?/);
        if (m) return m[1];
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  const projectRefOf = (base) => {
    try { return new URL(base).hostname.split(".")[0]; } catch { return null; }
  };

  // ---- finding Supabase's anon key -------------------------------------------

  const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

  function jwtPayload(token) {
    try {
      const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    } catch {
      return null;
    }
  }

  // A project anon key and a signed-in user's access token are both JWTs with
  // role "anon"-or-more. They differ in that a *user session* token identifies
  // a subject: it carries `sub` and/or `session_id`. We take only the project
  // key and never a session token — CLAUDE.md rule 2, never handle credentials.
  function isProjectAnonKey(token, ref) {
    const p = jwtPayload(token);
    if (!p) return false;
    if (p.role !== "anon") return false;
    if (p.sub || p.session_id) return false; // a user's token, not the project's
    return !ref || p.ref === ref;
  }

  // The key is baked into the JS Einstein serves us, so read it back out of
  // the page's own bundles rather than asking the student to go spelunking in
  // DevTools. localStorage is deliberately NOT searched: that is where the
  // user's Supabase session token lives.
  async function discoverApiKey(base) {
    const ref = projectRefOf(base);

    const fromInline = (document.documentElement.innerHTML.match(JWT_RE) || [])
      .find((t) => isProjectAnonKey(t, ref));
    if (fromInline) return { key: fromInline, source: "inline page markup" };

    const srcs = [...document.querySelectorAll("script[src]")]
      .map((s) => s.src)
      .filter((u) => { try { return new URL(u).origin === location.origin; } catch { return false; } });

    let budget = CONFIG.maxScriptBytes;
    for (const src of srcs) {
      if (budget <= 0) break;
      try {
        const text = await (await fetch(src)).text();
        budget -= text.length;
        const hit = (text.match(JWT_RE) || []).find((t) => isProjectAnonKey(t, ref));
        if (hit) return { key: hit, source: "script bundle " + src.split("/").pop() };
      } catch {
        /* a bundle we can't read is not fatal; try the next */
      }
    }
    return { key: null, source: null };
  }

  // ---- the sections call ------------------------------------------------------

  async function fetchSections(base, key, courseId) {
    const headers = { Accept: "application/json" };
    if (key) {
      headers.apikey = key;
      headers.Authorization = "Bearer " + key;
    }

    const call = (filter) =>
      fetch(`${base}/sections?select=*&course_id=${filter}`, { headers });

    // PostgREST needs an operator: `course_id=eq.<id>`. recon-findings.md
    // recorded the bare form, which PostgREST rejects with 400 — retry it once
    // in case this backend is not PostgREST after all.
    let res = await call(`eq.${encodeURIComponent(courseId)}`);
    if (res.status === 400) res = await call(encodeURIComponent(courseId));

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const hint = res.status === 401 || res.status === 403
        ? " (missing or rejected apikey — see the API key box in the popup)"
        : "";
      throw new Error(
        `sections API ${res.status} ${res.statusText}${hint}` +
        (body ? " — " + body.trim().slice(0, 200) : "")
      );
    }
    return res.json();
  }

  // needCart's exact field names for the chosen sections are only known from a
  // truncated capture, so this is deliberately forgiving: collect anything that
  // looks like a section name ("001") or section_id (10603) from any plausible
  // field, and match against the API's section list by either.
  //
  // DANGER, and the reason for the guards in matchChosen() below: `sections` is
  // in this list, and a needCart entry may well carry the course's ENTIRE
  // section list rather than the student's picks. Matching "everything" then
  // looks exactly like matching correctly, and the cart silently fills with
  // every lecture and recitation of the course. Never guess — refuse.
  const SECTION_FIELDS = [
    "sections", "selected_sections", "selectedSections", "chosen_sections",
    "section_ids", "sectionIds", "section", "lecture", "recitation",
    "lecture_section", "recitation_section",
  ];

  function chosenSectionKeys(entry) {
    const keys = [];
    for (const field of SECTION_FIELDS) {
      const v = entry[field];
      if (v == null) continue;
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x == null) continue;
        if (typeof x === "object") {
          for (const k of [x.section_id, x.id, x.name]) {
            if (k != null) keys.push(String(k));
          }
        } else {
          keys.push(String(x));
        }
      }
    }
    return [...new Set(keys.filter(Boolean))];
  }

  function matchSections(sections, keys) {
    return sections.filter((s) =>
      keys.some((k) => String(s.section_id) === k || String(s.name) === k)
    );
  }

  // Resolve the sections the student actually picked, or refuse.
  //
  // Every failure mode here has the same shape: we cannot distinguish "read the
  // student's choice" from "echoed the course's whole section list back". Adding
  // the wrong sections to a real enrollment cart is worse than importing
  // nothing, so each ambiguity is an error, not a warning.
  function matchChosen(entry, sections) {
    const keys = chosenSectionKeys(entry);
    const chosen = matchSections(sections, keys);

    // Only one section exists — there is nothing to choose.
    if (sections.length === 1) return sections;

    if (!keys.length || !chosen.length) {
      throw new Error(
        `needCart records no section choice (fields present: ${Object.keys(entry).join(", ")}) ` +
        `and the course has ${sections.length} sections — refusing to guess`
      );
    }

    // Matched every section the API returned: needCart handed us the catalog,
    // not a choice.
    if (chosen.length === sections.length) {
      throw new Error(
        `needCart's section fields matched all ${sections.length} sections of this course, ` +
        `so they list the course's sections rather than your picks — refusing to guess`
      );
    }

    const primaries = chosen.filter((s) => !isSecondary(s));
    if (primaries.length > 1) {
      throw new Error(
        `${primaries.length} lectures matched (${primaries.map((s) => s.name).join(", ")}) — ` +
        `needCart's chosen-section fields were not understood`
      );
    }

    // A course can legitimately require both a lab and a recitation, so more
    // than one secondary is fine — but two of the SAME type means we matched
    // every option instead of the one picked.
    const byType = {};
    for (const s of chosen.filter(isSecondary)) {
      const t = (s.type || "other").toLowerCase();
      (byType[t] ||= []).push(s.name);
    }
    for (const [type, names] of Object.entries(byType)) {
      if (names.length > 1) {
        throw new Error(
          `${names.length} ${type} sections matched (${names.join(", ")}) — ` +
          `needCart does not say which one you chose`
        );
      }
    }

    return chosen;
  }

  // A course's non-primary components. Albert calls the screen "Related Class
  // Sections"; Einstein types them Recitation / Lab / Discussion.
  const SECONDARY_TYPE = /recitation|lab|discussion|workshop/i;
  const isSecondary = (s) => SECONDARY_TYPE.test(s.type || "");

  // How needCart actually records the student's picks: every section of the
  // course is present, and the chosen ones carry `enabled: true`. Confirmed
  // against a real schedule. No API call is needed to learn the picks.
  function pickEnabled(entry) {
    const secs = Array.isArray(entry.sections) ? entry.sections : null;
    if (!secs || !secs.length) return null; // fall back to the API matcher

    const enabled = secs.filter((s) => s.enabled === true);
    if (!enabled.length) {
      throw new Error(
        `none of the ${secs.length} sections in needCart are enabled:true — ` +
        `finish choosing sections for this course on Einstein first`
      );
    }
    return enabled;
  }

  // Shared shape check, whichever source produced `chosen`. A course may
  // legitimately require both a lab and a recitation, but two sections of the
  // same type means we read options rather than a pick.
  function validateChosen(chosen, ctx) {
    const primaries = chosen.filter((s) => !isSecondary(s));
    if (!primaries.length) throw new Error(`${ctx}: chosen sections include no lecture/primary`);
    if (primaries.length > 1) {
      throw new Error(
        `${ctx}: ${primaries.length} primary sections chosen (${primaries.map((s) => s.name).join(", ")})`
      );
    }

    const byType = {};
    for (const s of chosen.filter(isSecondary)) {
      const t = (s.type || "other").toLowerCase();
      (byType[t] ||= []).push(s.name);
    }
    for (const [type, names] of Object.entries(byType)) {
      if (names.length > 1) {
        throw new Error(`${ctx}: ${names.length} ${type} sections chosen (${names.join(", ")})`);
      }
    }
    return { primary: primaries[0], secondaries: chosen.filter(isSecondary) };
  }

  // Einstein times: [{meet_day (0-indexed), start_time, end_time}] in minutes
  // since midnight. Kept so albert.js can match a recitation by day+start time
  // when its class number isn't one Albert offers under the chosen lecture.
  const toMeetings = (s) =>
    (Array.isArray(s.times) ? s.times : [])
      .filter((t) => t && t.start_time != null && t.meet_day != null)
      .map((t) => ({ day: t.meet_day, start: t.start_time, end: t.end_time ?? null }));

  const toComponent = (s) => ({
    type: s.type || "Class",
    section: s.name ?? null,
    classNbr: String(s.section_id), // section_id IS Albert's class number
    status: s.status || null,
    meetings: toMeetings(s),
  });

  // Two kinds of thing worth telling the user, kept apart because they render
  // differently: `warnings` are one-liners that belong on the card; `notes` is
  // multi-paragraph registration prose that must stay collapsed.
  function inspect(sections) {
    const warnings = [];
    const restrictions = [];
    for (const s of sections) {
      const label = `${s.type || "Section"} ${s.name}`;
      if (s.status && !/^open$/i.test(s.status)) warnings.push(`${label} is ${s.status}`);
      const note = String(s.notes || "").trim();
      if (note) restrictions.push({ label, text: note });
    }
    return { warnings, restrictions };
  }

  async function report(result) {
    await chrome.storage.local.set(result);
  }

  async function main() {
    const errors = [];
    const semester = localStorage.getItem("semester") || null;

    const raw = localStorage.getItem("needCart");
    if (!raw) {
      return report({
        stq_import: {
          ok: false, count: 0, semester, at: Date.now(),
          errors: ["needCart not found in localStorage — is this the Einstein tab with a planned schedule?"],
        },
      });
    }

    let cart;
    try {
      cart = JSON.parse(raw);
    } catch (e) {
      return report({
        stq_import: {
          ok: false, count: 0, semester, at: Date.now(),
          errors: ["needCart is not valid JSON: " + e.message],
        },
      });
    }
    if (!Array.isArray(cart) || cart.length === 0) {
      return report({
        stq_import: {
          ok: false, count: 0, semester, at: Date.now(),
          errors: ["needCart is empty — plan some classes on Einstein first."],
        },
      });
    }

    const mock = readMockSections();
    const base = mock ? null : CONFIG.apiBase || discoverApiBase();

    // Supabase authenticates with a project key, not the session cookie. Prefer
    // one the student pasted; otherwise read it out of Einstein's own bundles
    // and cache it, since re-scanning them on every import is wasteful.
    //
    // None of this is required any more: picks come from needCart's `enabled`
    // flag. A missing key only costs us the live status refresh, so it is a
    // warning, never a failed import.
    let key = CONFIG.apiKey || null;
    let keySource = key ? "einstein.js CONFIG" : null;
    if (!mock && base && !key) {
      const saved = (await chrome.storage.local.get("stq_supabase_key")).stq_supabase_key;
      if (saved) { key = saved; keySource = "saved in extension storage"; }
      else {
        const found = await discoverApiKey(base);
        if (found.key) {
          key = found.key;
          keySource = found.source;
          await chrome.storage.local.set({ stq_supabase_key: key });
        }
      }
    }
    const canRefresh = !!(mock || (base && key));

    const debug = {
      apiBase: base,
      keySource, // never the key itself
      canRefreshStatus: canRefresh,
      needCartLength: cart.length,
      entryKeys: Object.keys(cart[0] || {}),
      sampleEntry: cart[0] ?? null,
    };

    const queue = [];
    for (const entry of cart) {
      const courseId = entry.course_id ?? entry.courseId ?? entry.id;
      const courseCode = entry.course_code ?? entry.courseCode ?? `course ${courseId}`;
      try {
        if (courseId == null) throw new Error("entry has no course_id");

        // The picks come straight from needCart. Only fall back to the API
        // matcher for entries that don't carry a sections[] array at all.
        let chosen = pickEnabled(entry);
        let pickSource = "needCart enabled:true";
        let hitNetwork = false;

        if (!chosen) {
          const sections = mock
            ? mock[String(courseId)] || []
            : await fetchSections(base, key, courseId);
          hitNetwork = !mock;
          if (!sections.length) throw new Error("sections API returned nothing");
          chosen = matchChosen(entry, sections);
          pickSource = "Supabase sections + needCart fields";
        }

        const { primary, secondaries } = validateChosen(chosen, courseCode);

        // Optional: refresh `status` against live data, because needCart's copy
        // can be stale and a class that was Open when planned may be Closed on
        // enrollment day. Never fatal — a stale status is far better than a
        // failed import.
        const refreshNotes = [];
        if (CONFIG.refreshStatus && !hitNetwork && canRefresh) {
          try {
            const live = mock
              ? mock[String(courseId)] || []
              : await fetchSections(base, key, courseId);
            const byId = new Map(live.map((s) => [String(s.section_id), s]));
            for (const s of chosen) {
              const fresh = byId.get(String(s.section_id));
              if (fresh) {
                if (fresh.status) s.status = fresh.status;
                if (fresh.notes != null) s.notes = fresh.notes;
                // needCart may lack `times`; the live section has them, and
                // albert.js needs them to match a recitation by time.
                if (Array.isArray(fresh.times) && fresh.times.length) s.times = fresh.times;
              }
            }
            if (!mock) await sleep(CONFIG.delayBetweenCoursesMs);
          } catch (e) {
            refreshNotes.push(`live status unavailable (${e.message.slice(0, 80)}) — showing Einstein's cached status`);
          }
        } else if (CONFIG.refreshStatus && !canRefresh && !hitNetwork) {
          refreshNotes.push("live status not refreshed (no Supabase key) — showing Einstein's cached status");
        }

        const { warnings, restrictions } = inspect([primary, ...secondaries]);
        warnings.push(...refreshNotes);

        // Albert's waitlist control has never been captured (CLAUDE.md open
        // question 4), so a waitlisted pick is surfaced but NOT auto-opted-in.
        const waitlisted = [primary, ...secondaries].filter((s) => /wait\s*list/i.test(s.status || ""));
        for (const s of waitlisted) {
          warnings.push(
            `${s.type || "Section"} ${s.name} is "${s.status}" — Albert's waitlist control ` +
            `has not been captured yet, so the extension cannot tick it for you`
          );
        }

        queue.push({
          courseCode,
          title: entry.title ?? entry.course_title ?? null,
          // `components` is what the popup renders: lecture first, then each
          // recitation/lab with its own class number.
          components: [toComponent(primary), ...secondaries.map(toComponent)],
          // Flat fields kept because albert.js still reads them; its rewrite
          // against real Albert will move over to `components`.
          classNbr: String(primary.section_id),
          lectureSection: primary.name,
          recitationSection: secondaries[0] ? secondaries[0].name : null,
          recitationClassNbr: secondaries[0] ? String(secondaries[0].section_id) : null,
          // The chosen recitation's meeting times, for albert.js's time-match
          // fallback when its class number isn't offered under the lecture.
          recitationMeetings: secondaries[0] ? toMeetings(secondaries[0]) : [],
          // The LECTURE's meeting times. The lecture's class number is a confirmed
          // match between Einstein and Albert, and Albert prints its schedule on the
          // recitation screen — so albert.js aligns the two to DERIVE Einstein's day
          // origin and time format instead of assuming them.
          lectureMeetings: toMeetings(primary),
          permissionNbr: "",
          waitlistOk: false,
          needsWaitlist: waitlisted.length > 0,
          pickSource,
          warnings,
          restrictions,
        });
      } catch (e) {
        errors.push(`${courseCode}: ${e.message}`);
      }
    }

    await report({
      stq_queue: queue,
      stq_status: {},
      stq_import: {
        ok: queue.length > 0,
        count: queue.length,
        semester,
        errors,
        at: Date.now(),
        // Always. A silently *wrong* import (all sections matched) used to look
        // like a successful one, and hid the evidence needed to diagnose it.
        debug,
      },
    });
  }

  main()
    .catch(async (e) => {
      await report({
        stq_import: { ok: false, count: 0, semester: null, errors: ["importer crashed: " + e.message], at: Date.now() },
      });
    })
    .finally(() => {
      window.__STQ_EINSTEIN_RUNNING__ = false; // allow re-import without reloading
    });
})();
