# CLAUDE.md — "Relativity" Chrome Extension (formerly "Send to Albert")

You are helping me (Charles, NYU CS/Math student) build a Chrome extension that
transfers a class schedule from EinsteinNYU (a student-built course planner at
einsteinnyu.com) into NYU Albert's enrollment shopping cart.

**Read `recon-findings.md` too — it is the authoritative, verified DOM reference
for Albert. Every selector in it was captured live. Do not code against
assumptions; if you need DOM you haven't seen, capture it first (see "The probe"
below). Every single time this project guessed at Albert's DOM, it was wrong.**

> `recon-findings.md` is **deliberately not published** — it is gitignored and
> exists only in the author's working copy. It is a live map of a university
> system's internals, which is not something to hand out. Code comments and the
> notes below still reference it; those references will dangle for anyone who
> cloned this repo, and that is intended, not a mistake.

## The core idea

Albert (NYU's registration system, Oracle PeopleSoft) is painful to use.
Einstein is a nice unofficial planner, but after building a schedule there,
students still manually re-enter every class into Albert. This extension closes
that gap: it reads the planned schedule from Einstein, then automates the
"Add Classes" flow — inside the student's own already-logged-in browser session.

Status: **working end to end (v2.1.0)**. Import from Einstein → fill Albert's
cart (recitations, permission codes, waitlist) → clear the cart. Never enrolls.

The name is the joke that was already there: NYU's registrar is **Albert**, the
planner is **Einstein**. Albert Einstein → **Relativity**.

## Non-negotiable safety rules

1. **NEVER advance past the shopping cart.** The extension fills the cart
   (Step 1) and hard-stops. It must never trigger "Proceed to Step 2 of 3"
   (`DERIVED_REGFRM1_LINK_ADD_ENRL`), "Enroll", "Validate"
   (`DERIVED_REGFRM1_SSR_VIEW_STAT_RPT`), or "Finish Enrolling". Two guards:
   `albert.js` `bridgeSubmit()` refuses by label, id, AND the href's
   submitAction arg; `bridge.js` refuses again in the MAIN world. Keep both.
2. **Never handle credentials.** No passwords, no login automation. We piggyback
   on the session the student already has. `einstein.js` deliberately refuses any
   JWT carrying `sub`/`session_id` so it can never grab a user session token.
3. **Minimal permissions.** `activeTab` + `scripting` + `storage`, plus
   host_permissions narrowly scoped to the two Albert origins
   (`https://sis.nyu.edu/*`, `https://sis.portal.nyu.edu/*`). The host grant is
   NOT optional — see "Architecture" below. Never broaden to `<all_urls>`.
4. **Match elements by id/content, never by screen position.** Recitation lists
   vary in length per class.
5. Be gentle with Einstein's API; human-paced, user-initiated actions only.

## Architecture — why it's built this way

Three facts about Albert forced the design. All were discovered the hard way:

1. **Albert's controls live in a cross-origin subframe.** Top frame is
   `sis.portal.nyu.edu`; the real UI is `iframe#lbFrameContent` at
   `sis.nyu.edu`. Both set `document.domain = "nyu.edu"`, so the top frame can
   *read* the subframe — but running a script *inside* it needs a host
   permission. `activeTab` alone silently skips it (symptom: probes reported the
   frame map but never a result).
2. **Isolated-world clicks do not work.** `anchor.click()` on Albert's
   `javascript:submitAction_win0(...)` links does nothing: Blink evaluates the
   `javascript:` URL in our isolated world (where the function doesn't exist),
   and the page CSP blocks `javascript:` navigations outright. This is
   unfixable — don't chase it.
3. **So everything goes through `bridge.js`** — injected `world:"MAIN"` — which
   calls `submitAction_win0` *by name* in the page's own world. The isolated
   world commands it over `window.postMessage` (NOT CustomEvent: `detail` is
   nulled across worlds). The handshake is same-window, so it must run *inside*
   the control frame. The page CSP whitelists the extension's origin in
   `script-src`, so the MAIN-world injection is allowed.

**PeopleSoft submits are partial refreshes (PPR), not navigations** — the
document survives, but the swap takes a server round-trip (~0.5–2s). Reading the
DOM immediately after a submit returns the OLD screen. `albert.js`
`settleAfterAction()` waits (MutationObserver: mutations start, then stop) after
every submit. Skipping this was the "Next is never clicked" bug: the code read
the still-present add screen and bailed before the recitation screen rendered.

## The files

- `manifest.json` — MV3. activeTab + scripting + storage + the two Albert hosts.
- `popup.html/.css/.js` — the UI. Three buttons: **Import from Einstein** (this
  is the START button — it wipes the whole previous session: queue, statuses, and
  leftover run messages), **Fill Albert's cart**, **Clear Albert's cart**.
  Each class is a collapsed card: chevron + course code + status chip, then
  Permission Code + "Waitlist if Full". Expanding shows sections, warnings and
  restrictions. A **failure renders its reason outside the disclosure** (red
  panel, bulleted list of what the lecture does offer) so it's visible without
  expanding. albert.js still records a per-class step log to
  `stq_status[i].log` for debugging, but nothing renders it.
- `icons/` — the purple bubble with a white **A** (NYU violet #57068C),
  generated by hand (no Pillow/ImageMagick available) at 16/32/48/128.
- `einstein.js` — reads `needCart` from localStorage, resolves picks + class
  numbers, writes `stq_queue`.
- `bridge.js` — the MAIN-world escape hatch. Hard allowlist: `submitAction_win0`
  only; refuses any enroll/validate/proceed argument.
- `albert.js` — the automation. Fill mode (add classes) and clearcart mode.
- `probe.js` — the recon tool. **The file stays; its UI does not.** Removed in
  v2.0, re-added in v2.4.0 to capture the permission-code behaviour, removed
  again in **v2.6.0** now that that's done. This is the settled pattern: wire it
  up when there's DOM to learn, unwire it when there isn't — but never delete the
  file, because it is the ONLY way to re-learn Albert's DOM if NYU changes the
  page, and everything it has found is in `recon-findings.md`.
  To use it again, re-add a dev section that injects `bridge.js` (world MAIN)
  then `probe.js`, with `stq_probe_mode` = read / cart / screen / submit and
  `stq_probe_action` for the submit actions. Reports land in `stq_probe`.
  Git history has the whole popup wiring — `git log -- popup.html` around v2.4.0.
- The old `test-albert.html` / `test-einstein.html` mocks are **deleted**. They
  were superseded and then removed: the real flow needs the page's own
  `submitAction_win0` plus the cross-origin bridge, which a mock cannot
  reproduce, so passing against the mock meant nothing. Testing happens on real
  Albert with a throwaway class + Clear Cart.

## Einstein: how the schedule is read

- **`needCart` (localStorage) holds the picks via an `enabled` flag.** Each entry
  carries the course's FULL `sections[]`; the chosen ones have `enabled: true`.
  No network call is needed to learn the picks. `section_id` **IS** Albert's
  class number.
  - Trap: `SECTION_FIELDS` includes `"sections"`, so an older matcher scooped up
    *every* section and "matched" all of them — indistinguishable from success.
    `validateChosen()` now refuses any result matching all sections, two
    primaries, or two secondaries of the same type.
- **Einstein's backend is Supabase** (`qvmltlbxzbbrvphhkeog.supabase.co`,
  PostgREST at `/rest/v1/`). Two gotchas:
  - Auth is a header, not a cookie: needs `apikey` + `Authorization: Bearer`
    with the **public anon key** (auto-discovered from Einstein's own script
    bundles, cached in `stq_supabase_key`). Without it: 401.
  - PostgREST filters need an operator: `?course_id=eq.19857666`. The bare form
    returns 400.
  - This is now only used for an optional live `status`/`notes`/`times` refresh.
    A missing key is a warning, never a failed import.

## Albert: the add-class flow (all verified live — details in recon-findings.md)

Fluid component `NYU_SSENRL_CART_FL.GBL`, but with Classic-style `a.ps-button`
controls driving `submitAction_win0`.

1. **Add screen** — `input#DERIVED_REGFRM1_CLASS_NBR` (maxlength 5). Enter button
   is `a#BUTTON_SMALL` (text "Enter").
   ⚠ **`SMALL_BUTTON` is a different button labelled "Search"** — the ids are
   transpositions. Always assert the visible text before submitting.
   Typing does not submit; the Enter anchor must be driven.
2. **Related Class Sections** (if the class has components) — one grid row per
   OPEN recitation. Row N's class number is `span#SSR_CLS_TBL_R1_RELATE_CLASS_NBR$N`;
   its picker is `select#NYU_DERIVED_SR_ROW_STATUS$N` (""/N/**Y**). Setting Y
   self-submits and reveals **Next**. Closed recitations aren't listed.
3. **Enrollment Preferences** — shown for *some* classes, skipped for others
   (hence the screen-detector loop, not a fixed sequence). Holds:
   - `select#DERIVED_CLS_DTL_WAIT_LIST_OKAY$N` — "Wait list if class is full?"
     (""/N/**Y**). A **select, not a checkbox**.
   - `input#DERIVED_CLS_DTL_CLASS_PRMSN_NBR$N` — permission code, maxlength 6.
     **Present but usually OPTIONAL** — never abort just because it exists.
     ⚠ **Albert does NOT clear this field between classes.** The value stays in
     PeopleSoft's page buffer, so a code entered for class 1 — above all one that
     was just REJECTED — is still sitting in the box when class 2 reaches this
     screen, and would be submitted for a class it has nothing to do with.
     `albert.js` therefore **always writes** the field on the prefs screen (the
     student's code, or `""` to wipe it) and also calls `clearPermissionFields()`
     on the way out of a failed class. Never "fill only if we have a code".
4. **Next** = `a#DERIVED_CLS_DTL_NEXT_PB` → commits to the cart.
   Cancel = `a#DERIVED_CLS_DTL_CANCEL_PB`.
5. **Result modal** — text in `div#ptModContent_0` / `#alertmsg`; dismiss via
   `a[id="#ICOK"]` (id literally starts with `#`; its action is in `onclick`, so
   a synthetic click is used — the CSP warning about its `javascript:void(0)`
   href is harmless noise).

`albert.js` is a **screen-detector state machine**: enter class → detect
{recitation | next | success/duplicate/error modal} → act → repeat. A failed
class never stops the run; it records why and moves on.

### Recitation matching (and the time fallback)

Einstein doesn't tie a recitation to a specific lecture, so the recitation class
number it records may not be one Albert offers under the chosen lecture. Order:
1. exact recitation class number,
2. section number,
3. **meeting time** — `same day + same start time`. **Nothing about Einstein's
   format is assumed**, because both its time encoding and its day origin are
   unverified:
   - `toMinutes()` accepts minutes-since-midnight (`570`), 24-hour strings
     (`"09:30"`, `"13:30:00"`), and 12-hour (`"9:30AM"`).
   - `toDayIdx()` accepts integers or day words (`"M"`, `"Th"`, `"Friday"`).
   - **The integer day origin is CALIBRATED, not guessed**: the *lecture's* class
     number is a confirmed match between the two systems, and Albert prints the
     lecture's schedule on the recitation screen
     (`DERIVED_CLS_DTL_SSS_LONGCHAR*`). `calibrateDayOffset()` aligns Einstein's
     `lectureMeetings` against it to derive the offset (0=Mon, 0=Sun, whatever),
     then applies it to the recitation. Falls back to 0=Monday only if the
     lecture schedule is unavailable — and says so in the class's status.
   - `parseSchedule()` anchors the day cluster to the time, so room names like
     "Warren **We**aver" or "**Th**ompson St" can't inject a bogus day.
   - **THE DAY MUST MATCH.** If day+start finds nothing, the class is REFUSED and
     skipped — the error names the wanted day/time and lists every recitation the
     lecture actually offers (`#10454 sec 017 (Fr 12:30PM - 1:45PM); …`) so the
     student can fix their Einstein pick. A same-time-but-wrong-day recitation is
     the wrong class; never quietly cart it. (An earlier "start time only"
     fallback did exactly that — it is gone.)
   - Ties (same day AND time): pick the first, and say so.

## Albert: clearing the cart (verified live)

Select-then-act, NOT per-row delete:
- Each **lecture** row has `select#P_SELECT$N` (""/N/**Y**). Labs/recitations
  have no selector — they're removed with their lecture.
- Global Delete: `a#DERIVED_REGFRM1_SSR_PB_DELETE`.
- Clicking Delete without selecting first is a no-op (this was a real bug).
- ⚠ The cart page also hosts **Validate / Enroll / Proceed to Step 2** — the
  forbidden three. `deleteButton()` only ever returns the control whose text is
  exactly "Delete".

## The probe (`probe.js`) — how to learn Albert's DOM

**Not wired to the popup right now** (see "The files"). Re-add a dev section to
use it. Never guess DOM; capture it.

- **Read-only** — dumps frames, the add screen, every clickable, forbidden hits.
- **Capture current screen** — read-only dump of whatever class-detail screen you
  have navigated to by hand. **This is the safest way to capture screens whose
  navigation could commit something** (it's how the waitlist screen was captured).
- **Submit 99999** + an action string, one action only:
  - `bridge:<id>` — set 99999, fire `submitAction_win0` via the bridge (validates
    the whole chain; 99999 is not a real class, so it just errors).
  - `enter:<classNbr>` — enter a real class, capture the recitation screen, Cancel.
  - `prefs:<lecture>:<rec>` — also pick the recitation, capture, Cancel.
  - `wl:<lecture>:<rec>` — one Next further (waitlist screen), Cancel.
  - `click:<id>` / `key:Enter` — proven inert (CSP); kept as evidence.
  - ⚠ `perm:<lecture>:<rec>:<code>` (v2.4.0) — types a **bad permission code** and
    drives the commit Next, to capture Albert's rejection. **The only probe action
    that can reach the cart**: every other one stops short, this one must not,
    because the error exists ONLY as the server's reply to that submit. If the
    code is accepted the class is carted (`landedInCart: true` in the report) —
    recoverable with Clear Cart, and it still cannot enroll. `rec` may be blank
    for a class with no components (`perm:10603::sdjksd`).
    It captures at **two** points, because a bad code can fail in two places:
    `afterTypingCode` (the field's `onchange` runs PeopleSoft's numeric
    `doEdits`, so a non-numeric code may be refused client-side with no submit at
    all) and `afterNext` (a well-formed but wrong code, refused by the server).
- Reports land in `chrome.storage` (`stq_probe`) and render in the popup, so
  closing it mid-run loses nothing. URLs are redacted (EMPLID stripped).
- Message text is reported **normalized and escaped** (` ` visible). Albert's
  duplicate message hides a U+00A0 that a normalized capture would have silently
  eaten — don't repeat that; copy the escaped form into `recon-findings.md`.

## Storage keys

`stq_queue` (classes), `stq_status` (per-class {state, message, log}),
`stq_run` (run-level status), `stq_run_mode` ("fill" | "clearcart"),
`stq_import` (import summary), `stq_probe` (probe report),
`stq_probe_mode` / `stq_probe_action` (what the probe should do),
`stq_supabase_key`, `stq_cart_debug`.

## Working style

- I'm an incoming sophomore; explain non-obvious decisions briefly as you go.
- **Ask, don't guess** — especially about Albert's DOM and about my intent.
- Ask before adding permissions or dependencies.
- Bump `manifest.json` version on every change; the popup header shows it, so I
  can tell at a glance whether I'm running the code you just wrote.
- Every behavioural change gets a check: the scratchpad tests cover the hard-stop
  guard, recitation time-matching, the anon-key discriminator, `enabled` picking,
  the bridge protocol, and popup rendering.

## Open / unverified

- **The permission code: what Albert really does (captured 2026-07-13, see
  `recon-findings.md` §1d).** Both assumptions we started with were wrong:
  - A **non-numeric** code is refused at Next with a generic *number field format
    error* that **never says "permission"** — so a matcher keyed on that word
    misses the only error Albert actually produces. `PERM_FORMAT` matches the
    format wording instead, and only blames the code when we typed one.
  - A **well-formed but wrong** code (`999999`) is **silently accepted and the
    class is carted** — Albert doesn't validate the number on a class that
    doesn't require permission. There is no error to detect there, so we don't
    pretend there is. This is also why the field MUST be overwritten every time:
    a stale code rides along silently instead of failing loudly.
  - The popup now strips non-digits from the permission box, so the format error
    should be unreachable in normal use — it stays detected as a backstop.
  - **Still open:** what a class that genuinely *requires* permission says to a
    wrong code. Never exercised (CSCI-UA 102 doesn't require one). `PERM_REJECTED`
    / `PERM_REQUIRED` are broad guesses for that case and are labelled as such.
    Capture it with the probe's `perm:` action on a permission-required class.
- `#ICOK` modal dismissal is best-effort (synthetic click). The class still lands
  in the cart if it fails; only the next class's start is affected.
- Einstein `meet_day` 0-index convention (0 = Monday assumed, see above).
- Whether `needCart` always carries section `times` (backfilled from the API when
  the anon key is available).
