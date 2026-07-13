

# Relativity

A Chrome extension that moves a planned class schedule from
[EinsteinNYU](https://einsteinnyu.com) (a student-built course planner) into
NYU Albert's enrollment shopping cart.

**It fills the cart. It never enrolls you.** Reviewing the cart and clicking
"Finish Enrolling" is always done by you, by hand. That is a hard architectural
guarantee, not a default setting—see [Safety](#safety).

The name is the joke that was already sitting there: NYU's registrar is
**Albert**, the planner is **Einstein**. Albert Einstein → *Relativity*.

## The problem

Albert is Oracle PeopleSoft. Einstein is a genuinely nice planner. But after
building a schedule in Einstein, you still have to retype every class number
into Albert one at a time, and each one with a recitation makes you pick the
recitation again from a grid. Relativity closes that gap.

## What it does

1. Reads your planned schedule out of Einstein (no login, no scraping of the
   rendered page, it reads the planner's own `needCart` state).
2. For each class, drives Albert's real "Add Classes" flow inside your own
   already-logged-in browser session: class number → recitation/lab → permission
   code → waitlist preference → add to cart.
3. Stops at the cart and reports what landed, what didn't, and why.

It also has a **Clear Albert's cart** button, because emptying the cart by hand
is its own chore.

A class that fails never stops the run. It is marked failed with a readable
reason, and the rest keep going.

## Safety

This automates a university registration system, so the constraints are worth
being explicit about.

- **It cannot enroll you.** "Proceed to Step 2 of 3", "Enroll", "Validate", and
  "Finish Enrolling" are refused by two independent guards—one in the
  extension's isolated world, one in the page's MAIN world—each checking the
  button's visible label, its element id, *and* the argument in its `submitAction`
  href. To make this extension enroll you, you would have to defeat both.
- **It never handles credentials.** No passwords, no login automation. It rides
  the session you already have. It goes further than that: the Einstein reader
  deliberately *refuses* any JWT carrying a `sub` or `session_id` claim, so it
  is structurally incapable of picking up a user session token — it will only
  accept the project's public anon key.
- **Minimal permissions.** `activeTab`, `scripting`, `storage`, plus host
  permissions narrowly scoped to `sis.nyu.edu` and `sis.portal.nyu.edu`. Never
  `<all_urls>`.
- **No background activity.** Everything is user-initiated and human-paced.
  Nothing runs unless you click a button.

## Install

Not on the Chrome Web Store. Load it unpacked:

1. Clone this repo.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → select the cloned folder.

## Use

[Watch the Demo Video on Youtube](https://youtu.be/wkpPPPTuHAY)

## How it works

Three facts about Albert forced the architecture, all of them learned the hard
way:

**Albert's controls live in a cross-origin subframe.** The top frame is
`sis.portal.nyu.edu`; the actual UI is an `iframe#lbFrameContent` served from
`sis.nyu.edu`. Both relax `document.domain` to `nyu.edu`, so the top frame can
*read* the subframe—but injecting a script into it requires a real host
permission. `activeTab` alone silently skips the frame.

**Isolated-world clicks do not work.** Albert's buttons are
`<a href="javascript:submitAction_win0(...)">`. Calling `.click()` from an
extension's isolated world does nothing: Blink evaluates the `javascript:` URL in
*our* world, where that function doesn't exist, and the page's CSP blocks
`javascript:` navigations anyway.

**So everything routes through a MAIN-world bridge** (`bridge.js`), which talks
to the extension over `window.postMessage` and holds a hard allowlist: it will
call exactly one function, `submitAction_win0`, and refuses any argument matching
enroll/validate/proceed/finish.

Two more things that are not obvious:

- Albert's screens are not a fixed sequence — the Enrollment Preferences screen
  appears for some classes and not others — so the flow is a **screen detector**,
  not a script.
- PeopleSoft refreshes partially, over XHR. Every submit is followed by a
  MutationObserver-based settle. Skipping this was the cause of the longest bug
  in this project's history ("Next is never clicked". It was, but the DOM was
  read before the page had reacted).

### Files

| File | Role |
| --- | --- |
| `einstein.js` | Reads `needCart`, resolves your picks and their class numbers. |
| `albert.js` | The automation. Fill mode and clear-cart mode. |
| `bridge.js` | MAIN-world escape hatch. Allowlisted, refuses enroll actions. |
| `popup.js` / `popup.css` | The UI. |
| `probe.js` | Read-only recon tool for re-learning Albert's DOM. Not wired to the UI. |
| `icons/make_icon.py` | Generates the icon set. |

## Known limits

- Einstein does not record which recitation belongs to which lecture. When the
  class number doesn't resolve directly, Relativity falls back to matching on
  **day + start time**, and the day must match. If your recitation isn't offered
  under that lecture, it refuses the class and lists what the lecture actually
  offers, rather than quietly carting the wrong section.
- Recitation matching only considers sections Albert shows as open.
- Tested on the Fall 2026 cart. NYU changes Albert's DOM without warning; if a
  selector breaks, `probe.js` is how you find the new one.

## Disclaimer

Unofficial. Not affiliated with, endorsed by, or supported by New York
University. It automates a UI you already have access to, in your own browser,
under your own session. Use it on your own registration, and check the cart
before you enroll—the whole design assumes you are the one who presses the
final button.

## License

MIT — see [LICENSE](LICENSE).
