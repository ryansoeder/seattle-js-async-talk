# Build Spec — Trial Finder (Async Scheduling Talk)

**Authoritative. Supersedes `HANDOFF.md`, `SPEC.md`, and `PROJECT-SPEC.md`. Ignore all three.**

---

## 0. The constraint

Build **ONE app**: one HTML file with an inline `<script>`, plus one worker file.
No build step, no framework, no `package.json`, no second page.

Do not create a separate demo per technique. A previous attempt built twelve separate
apps and was discarded. Every technique below lives in the same running app, operating
on the same data, triggered by the same few user actions.

Do not add any technique not listed in §3.

---

## 1. What this is for

A 30-minute conference talk on JavaScript scheduling. A slide deck runs alongside the
app. The talk is five **segments**, and every segment follows the same three beats:

1. **Before:** the app visibly misbehaves — loading jitter, a broken panel, or a
   frozen form.
2. **Slide:** one technique, and where its work lands — call stack, task queue, or
   microtask queue.
3. **After:** the presenter uncomments one block, reloads, repeats the same action, and
   the misbehavior is gone. A Chrome DevTools recording confirms it (§6).

**One technique per segment.** No segment's fix may depend on a second technique.

**Preferred "before" states:** an unresponsive interface or visible loading jitter
beats a merely slow one. Slow is acceptable only where nothing more visible is honest.
Never manufacture a symptom — see the design rule below.

**Talk thesis:** *"Your app isn't slow, it's badly scheduled."*

**Design rule for this rebuild:** every technique must do the job it was invented for.
The test is: *would someone building this app with no talk in mind end up writing
this code?* The previous design failed that test in two places — it split one search
into several requests the API could have combined, and it injected a fake failure to
justify `allSettled`. Do not reintroduce either.

---

## 2. The app

A trial finder for a patient. Three features, each the genuine home for some of the
techniques.

### Feature 1 — Search *(no segment)*

The patient enters their conditions in a profile form. The app sends **one** request to
ClinicalTrials.gov combining them with OR in `query.cond` (Essie expression syntax —
verify in §5), restricted to recruiting trials.

Results are paginated by cursor (`nextPageToken`) and fetched **one page after
another**, because page 2's token only exists once page 1 returns. This is a genuine
sequential dependency and is correct as written.

The table renders trial name, status, phase, conditions, and a link. All registry text
is sponsor-submitted and **must be escaped** before insertion — never interpolate it
raw into `innerHTML`.

### Feature 2 — Enrich a shortlist *(segments 1–2)*

The patient stars several trials to compare. The app enriches the shortlist from
**independent services that cannot be combined into one request**:

- **openFDA drug labels** for the shortlist's drug interventions — what the drug is,
  approved uses, warnings. openFDA's responses carry a disclaimer not to rely on them
  for medical decisions; show it wherever openFDA content appears.
- **PubMed** summaries for the shortlist's referenced publications (PMIDs)

**One request per service**, batched across the whole shortlist. Do not send one
request per trial — both services can take multiple names or IDs per call, and a
per-trial loop would be the same staging error as before.

Intervention names and PMIDs come from the original search response (request them
via `fields`), so the two services do not depend on each other or on a further
ClinicalTrials.gov call. That makes them genuinely parallelizable.

**The failure is real, not injected:** trials frequently test investigational drugs
that have no FDA label. openFDA returns HTTP 404 when a search matches nothing
(verified, §5). A shortlist containing only investigational compounds
therefore makes the openFDA request fail while PubMed succeeds. Rate limits and outages
are further genuine failure modes.

### Feature 3 — Eligibility matching *(segments 3–5)*

The app scores every loaded trial against the patient's profile — age, sex,
conditions, current medications, prior treatments — by processing each trial's
`eligibilityCriteria`, the free-text inclusion/exclusion prose written by sponsors.

**This runs in the browser on purpose.** Sending a patient profile to a server means
transmitting health information. Matching client-side keeps the profile on the device.
That is a genuine architectural reason the work is local CPU work rather than an API
call.

**Matching runs when the patient clicks *Update matches***, and the patient keeps
editing the profile form while it runs. That is why the main thread has to stay
responsive — a frozen form is the visible failure. Matching does not re-run on every
keystroke; one run at a time keeps the demo legible. If a new run starts before the
previous one finishes, discard the older run's results (a simple run counter — plumbing,
not a taught technique).

The matcher does not need to be clinically correct. It must be **real work**:
tokenizing the prose, splitting inclusion from exclusion sections, handling negation,
extracting age ranges, and scoring term overlap. **Never fake cost** with a busy-wait.
If it measures too fast (§5), the honest response is a broader realistic search, not
artificial delay.

---

## 3. The five segments

| # | Before (what the audience sees) | Technique | After | Where the work lands |
|---|---|---|---|---|
| 1 | Spinner vanishes instantly; sections pop in one by one and shove the page around | `Promise.all` — and why `forEach` drops promises | Spinner holds; everything lands in one pass | `forEach` callbacks run until their first `await` and their continuations become microtasks, but `forEach` returns immediately and the code after it runs first. `Promise.all` gives one promise to wait on. |
| 2 | One drug has no FDA label, so the entire panel errors and PubMed's data is thrown away | `Promise.allSettled` | PubMed results show; openFDA section says no label was found | `all` rejects on the first failure; `allSettled` waits for every outcome. |
| 3 | Typing in the profile freezes; progress bar sits at 0% then snaps to 100% | `setTimeout(0)` chunking — contrasted with a microtask "yield" | Typing echoes; bar fills smoothly | A microtask continuation runs before the browser can paint. A `setTimeout` continuation is a task, so input and paint get a turn between chunks. |
| 4 | Same freeze as 3 | `scheduler.yield()` | Same responsiveness, and matching finishes sooner than in segment 3 | Continuation is prioritized ahead of other queued tasks and isn't subject to the nested-timer clamp. |
| 5 | Same freeze as 3 | Web Worker | Typing echoes; bar fills; main thread does no matching | A separate thread with its own stack and event loop; progress and results arrive as `message` tasks. |

`for...of` + `await` is **not** in the talk — it would put a second technique between
segment 1's problem and its fix.

---

## 4. Segment details

Each segment's code is a banner-commented block, e.g.
`// ===== SEGMENT 3 FIX: setTimeout(0) between chunks =====`.
Put a numbered index at the top of the file mapping each block to its search string.

**Segments 1–2 are cumulative**, both in one function, `enrichShortlist()`. Segment 2
starts from segment 1's fix.

**Segments 3–5 are alternatives.** Each starts from the **same frozen baseline**: a
plain synchronous loop calling `matchTrial(trial, profile)` over every loaded trial.
Before uncommenting a segment's fix, re-comment the previous segment's fix. All three
schedule the **same** `matchTrial` — never give a segment its own matcher.

### Segment 1 — loading jitter → `Promise.all`

**Before** — written the way people actually write it:

```js
showSpinner();
services.forEach(async (service) => {
  const data = await service.fetch(shortlist);
  renderSection(service.name, data);
});
hideSpinner();   // runs immediately — forEach didn't wait
```

The enrichment panel must sit **above** other content (such as the trial table), and
the two sections must have clearly different heights, so each late arrival visibly
pushes the page down.

**Action:** star three trials, click *Enrich*.
**Before:** spinner disappears instantly, the panel is briefly empty, then sections
appear one at a time in network order and the page jumps. In DevTools, each jump
shows up in the Performance panel's layout shift track.

**After:**

```js
showSpinner();
const results = await Promise.all(services.map((s) => s.fetch(shortlist)));
results.forEach((data, i) => renderSection(services[i].name, data));
hideSpinner();
```

Spinner holds until both responses arrive; one render pass; no layout shifts recorded;
enrichment time ≈ the slower service. Honest trade-off for the slide: rendering once
means waiting for the slowest service.

### Segment 2 — whole-panel failure → `Promise.allSettled`

**Before:** segment 1's fix, with a shortlist whose drug interventions are all
investigational. openFDA returns 404, `Promise.all` rejects, and the panel shows only
an error — PubMed's successful response is discarded.

**Required:** each service's `fetch` must check `res.ok` and throw on failure. `fetch`
only rejects when a request can't complete; a 404 resolves normally. Without the check,
the failure never surfaces.

**After:** `Promise.allSettled`. Render each result on its own: fulfilled → its
section; rejected → a plain message, *"No FDA label found for these drugs"* for a 404
or *"Drug information is unavailable right now"* otherwise.

Pick the demo shortlist from real search results and record it in stage mode.

### Segment 3 — frozen form → `setTimeout(0)`

**Baseline (before):** matching runs as one synchronous loop.

**Required visible elements:** a progress bar updated after every chunk, and the
profile form. The progress bar is essential: it can only visibly move if the browser
gets to paint between chunks.

**Action:** click *Update matches*, then immediately type into the profile's
medications field.
**Before:** keystrokes don't appear until matching ends, then arrive in a burst; the bar
sits at 0% and snaps to 100%. In DevTools: one long task spanning all of matching, and
long keystroke interactions.

**Microtask beat (inside this segment):** chunk the loop on a time budget (yield after
~10ms of work; keep the budget in a named constant at the top of the file) and yield
with:

```js
await Promise.resolve();
```

Nothing changes: still frozen, bar still snaps from 0 to 100. Visual proof that
microtasks all run before the browser can paint.

**Fix:**

```js
await new Promise((r) => setTimeout(r, 0));
```

Keystrokes echo as typed; the bar fills smoothly. In DevTools, the single long task
becomes many short tasks with gaps between them where input and paint happen. Record
the `match` duration — it may rise because nested timers are clamped to at least 4ms.

### Segment 4 — frozen form → `scheduler.yield()`

**Before:** the baseline again. **Fix** — same chunking as segment 3, different yield:

```js
const yieldToMain = () =>
  globalThis.scheduler?.yield?.() ?? new Promise((r) => setTimeout(r, 0));
```

Feature detection is required: Chromium supports `scheduler.yield()`, Safari does not,
and Firefox status was unclear when last checked. Present in Chrome. Do not claim
Firefox support in code comments or UI.

**After:** same responsiveness as segment 3; the `match` duration should be lower than
segment 3's. If gate 5 shows only a small gap, the talk presents this as the modern way
to write segment 3's fix rather than a dramatic improvement.

### Segment 5 — frozen form → Web Worker

**Before:** the baseline again. **Fix:** move `matchTrial` into the worker.

- The worker receives the loaded trials **once** per search and keeps them. Each run
  posts only the profile.
- The worker posts **progress messages** (about every 5%) and one final results message.
  The main thread drives the progress bar from those messages.
- Create **one** worker and reuse it. Never spawn per run.
- Wrap the one-time post of trials into the worker in a `worker:copy` measure (§6).
- Code comment: a worker cannot touch the DOM. Rendering the results stays on the
  main thread.

**After:** keystrokes echo and the bar fills. In DevTools, matching appears on the
worker's own thread track; the main thread's only real work is rendering the results.

---

## 5. Measure before building segments — gates

Run these first and report the numbers. Each one can change the design, and the talk
must only claim what these numbers support.

**Results so far** (measured in Chrome, single cold runs):

| Gate | Result |
|---|---|
| 1. CORS | **Pass.** ClinicalTrials.gov, openFDA, and PubMed E-utilities all accept browser requests. |
| 2. OR in `query.cond` | **Pass.** `diabetes` 24,561 · `hypertension` 12,559 · `diabetes OR hypertension` 35,729 — the union in one request. |
| 3. openFDA no-match | HTTP **404**, body `{"error":{"code":"NOT_FOUND","message":"No matches found!"}}` (tested with investigational CAR-T compound A2B395). |
| 7. Latencies | ClinicalTrials.gov ~264ms · openFDA ~340–405ms · PubMed ~340ms. Repeat before quoting on stage. |
| Status separator (§7) | **Resolved.** `|` and `,` both return 2,181 for recruiting diabetes trials vs 24,561 unfiltered. Keep `|`. |

Gates 4, 5, and 6 require the matcher and worker to exist; measure them during the build.

Note when choosing the demo profile: recruiting diabetes alone is 2,181 trials. A
two-condition profile may exceed the 3-page cap and trigger the truncation notice.

1. **CORS.** From a browser console on a non-NIH page, fetch one openFDA URL and one
   PubMed E-utilities URL. Both must succeed. If either fails, stop and report — the
   enrichment feature's sources need to change before anything else is built.
2. **OR in `query.cond`.** Confirm `diabetes OR hypertension` returns the union in one
   request, by comparing `totalCount` with the individual counts.
3. **openFDA's no-match behavior.** Search for an investigational compound with no
   label and record the exact status code and body. Segment 2's failure depends on it.
4. **Matcher cost.** Uninstrumented time for `matchTrial` over a realistic search, on
   normal and 4×-CPU-throttled hardware. If throttled total is under ~150ms, the freeze
   in segments 3–5 won't be visible; report it rather than inflating the work.
5. **The setTimeout clamp.** Total matching time under segments 3 and 4. Whatever the
   difference is, that is the number the talk uses.
6. **Worker copy cost.** Time to post the loaded trials into the worker.
7. **Enrichment latencies.** Each service's typical latency, so segment 1 can be
   explained against real numbers.

---

## 6. Measuring in Chrome DevTools

**There is no in-app metrics panel.** All measurement is shown in Chrome DevTools, so
the numbers on stage come from the browser, not from the app's own code.

### What the app must do to be readable in DevTools

Mark each phase with the User Timing API so it appears as a labeled bar in the
Performance panel's **Timings** track:

```js
performance.mark('match:start');
// ...matching...
performance.measure('match', 'match:start');
```

Use exactly these names, short enough to read on a projector:

| Measure | Wraps |
|---|---|
| `search` | the full paginated search |
| `enrich` | `enrichShortlist()` from click to final render |
| `match` | one matching run, start to final render |
| `worker:copy` | posting the loaded trials into the worker (segment 5) |

### What each segment shows

| Segment | Where to look | Before | After |
|---|---|---|---|
| 1 | Performance panel → layout shift track | Shifts as each section lands | No shifts |
| 2 | Network panel | openFDA 404; PubMed 200 but nothing rendered | Same 404; PubMed rendered |
| 3 | Performance panel → main thread + interactions | One long task across all of `match`; long keystroke interactions | Many short tasks with gaps; short interactions |
| 3 (microtask beat) | Performance panel → main thread | Still one long task — every chunk runs inside it, so the event loop never gets a turn | — |
| 4 | Performance panel → main thread + Timings | Same as segment 3's before | Short tasks with tighter gaps than `setTimeout`; shorter `match` bar |
| 5 | Performance panel → worker track | Same as segment 3's before | Matching on the worker's own thread track; main thread mostly idle |

Segment 5 is worth lingering on: the Performance panel draws the main thread and the
worker as two separate lanes, which is the two-barista diagram from the talk's opening,
drawn by Chrome.

### Keep in the app (these are ordinary UI, not metrics)

- the enrichment loading spinner (segment 1 depends on it)
- the matching progress bar (segments 3–5 depend on it)

### Stage practicalities

- DevTools text is tiny on a projector. Undock DevTools into its own window and zoom
  it (Cmd/Ctrl +) before the talk.
- Record each segment's before and after in rehearsal and save the traces. The
  Performance panel can load a saved trace, which is the fallback if a live recording
  misbehaves.
- Use the same CPU throttling setting for every recording; choose it from gate 4.

---

## 7. Data notes

**ClinicalTrials.gov:** `https://clinicaltrials.gov/api/v2/studies`. No key, public
domain. `pageSize` maximum is 1000. Pagination is cursor-based via `nextPageToken`;
every page must resend the original query parameters with `pageToken`. Cap at 3 pages
and tell the user when results were capped. Use `fields` to request only what's needed:
NCT ID, title, status, phase, conditions, eligibility criteria, intervention names, and
reference PMIDs. Full records are 15–20KB each and mostly unused.

The status filter uses `|` between values
(`RECRUITING|ENROLLING_BY_INVITATION|AVAILABLE`). Verified working — see §5.

**Stage mode:** three network services over conference wifi is too fragile. Record
real responses to local JSON and add a replay flag with a configurable latency per
service, so latencies on stage match the ones measured in §5. The live path remains the
default for development.

---

## 8. Out of scope

Virtualization · `content-visibility` · debounce/throttle · `AbortController` ·
`requestIdleCallback` · `scheduler.postTask` · streaming JSON parse ·
`SharedArrayBuffer` · `Atomics` · transfer lists · `OffscreenCanvas` · worker pools ·
service workers · any framework · any rendering optimization.

The one non-technique requirement is security: escape all registry and API text.

---

## 9. Acceptance criteria

- [ ] One HTML file plus one worker file. No build step.
- [ ] Search sends one request per page; conditions combined with OR.
- [ ] Enrichment sends one request per service, never one per trial.
- [ ] Five segments, each one technique, each with a visible before and after.
- [ ] Segment 1's "before" produces layout shifts visible in the Performance panel.
- [ ] Segment 2's failure comes from real data, not an injected bad request.
- [ ] Segments 3–5 each start from the same frozen baseline and schedule the same
      `matchTrial`.
- [ ] In the baseline and the microtask beat, the progress bar jumps 0 → 100 and typed
      characters arrive in a burst. Under each fix, the bar fills and typing echoes.
- [ ] Worker reused; trials posted once per search, profile posted per run.
- [ ] Every block indexed at the top of the file.
- [ ] `search`, `enrich`, `match`, and `worker:copy` appear in the Performance panel's
      Timings track. No in-app metrics panel.
- [ ] Every §5 gate measured and reported before the talk relies on it.
- [ ] Stage mode runs fully offline with configurable per-service latencies.
- [ ] All external text escaped. Code legible on a projector.

---

## Appendix — Terminology the code and slides must get right

- `setTimeout(fn, 0)` schedules a **task**, not a microtask.
- Microtasks: promise callbacks, `await` continuations, `queueMicrotask`,
  `MutationObserver`. They drain completely before the browser can render.
- Yielding with a task creates a **rendering opportunity**; it doesn't force a render.
  The browser renders on its own frame schedule.
- `await` suspends the **function**, not the thread.
- `async`/`await` provides concurrency, not parallelism. Only workers run code in
  parallel.
- "Render-blocking" already means resources that delay *first* paint. For a busy main
  thread, say "long task" or "blocks the main thread."

### Field paths

```
protocolSection.identificationModule.nctId
protocolSection.identificationModule.briefTitle
protocolSection.statusModule.overallStatus
protocolSection.designModule.phases                   → may be absent
protocolSection.conditionsModule.conditions           → free text
protocolSection.eligibilityModule.eligibilityCriteria → matcher input
protocolSection.armsInterventionsModule.interventions → name, type (DRUG, BIOLOGICAL, …)
protocolSection.referencesModule.references           → pmid
```
