# Demo Spec — Trial Finder (Async Scheduling Talk)

**Replaces every earlier document:** `TALK-APP-SPEC.md`, `CHANGES.md`, `PROJECT-SPEC.md`,
`SPEC.md`, `HANDOFF.md`. Ignore them all.

This is a **demo for a 30-minute conference talk, not a production app.** Build the
least code that makes each problem visible and each fix obvious. If a feature doesn't
serve one of the five segments, leave it out.

---

## 1. The talk

Five segments. Each one: the app visibly misbehaves → a slide explains one technique →
the presenter checks out that technique's branch, reloads, repeats the same action, and
the problem is gone. Chrome DevTools confirms it.

| # | Before | Technique | After |
|---|---|---|---|
| 1 | Spinner vanishes instantly; enrichment sections pop in one by one and shove the page down | `Promise.all` (and why `forEach` doesn't wait) | Spinner holds; everything lands at once |
| 2 | One drug has no FDA label, so the whole enrichment panel errors | `Promise.allSettled` | Publications show; drug section says no label found |
| 3 | Typing freezes during matching; progress bar jumps 0% → 100% | `setTimeout(0)` between chunks (vs. `await Promise.resolve()`, which doesn't help) | Typing echoes; bar fills smoothly |
| 4 | Same freeze | `scheduler.yield()` | Same responsiveness; matching finishes sooner than in 3 |
| 5 | Same freeze | Web Worker | Typing echoes; matching runs on its own thread |

---

## 2. The app — this much and no more

One page:

- **Profile form:** conditions (text, default `diabetes`), age, medications
  (comma-separated). Buttons: **Search** and **Update matches**.
- **Enrichment panel**, *above* the results table: an **Enrich selected** button, a
  loading spinner, and two sections — **Drug information** (openFDA) and
  **Publications** (PubMed). The two sections must be visibly different heights.
- **Matching progress bar.**
- **Results table:** checkbox, trial title, phase, match score. Show only the **top 50**
  by score — rendering thousands of rows would add jank of its own and muddy every
  recording.

No sorting, no filters, no pagination UI, no styling beyond legibility. Large font —
it will be on a projector.

---

## 3. Files

```
index.html     markup only
styles.css     all styles
app.js         everything on the main thread
matcher.js     matchTrial() only — loaded by index.html, and by the worker in branch 05
worker.js      branch 05 only
data/          saved API responses for offline mode
```

Plain `<script>` tags, no modules, no build step, no `package.json`. Serve with any
static server (`npx serve` or `python3 -m http.server`) — Chrome won't run a worker from
`file://`.

---

## 4. Branches

`00-baseline` contains **every problem at once**. Each fix branch is **one commit** on
top of its parent, so `git show` on that branch displays exactly the fix and nothing
else.

| Branch | Parent | Contains |
|---|---|---|
| `00-baseline` | — | All five problems |
| `01-promise-all` | `00-baseline` | Segment 1 fix |
| `02-allsettled` | `01-promise-all` | Segment 2 fix (its "before" is segment 1's fix) |
| `03a-microtask` | `00-baseline` | The attempted fix that **doesn't** work |
| `03-settimeout` | `00-baseline` | Segment 3 fix |
| `04-scheduler-yield` | `00-baseline` | Segment 4 fix |
| `05-worker` | `00-baseline` | Segment 5 fix |

On stage: `git checkout <branch>`, reload, repeat the action, record in DevTools.

Useful diffs for slides:

- `git diff 00-baseline 03-settimeout` — the whole segment 3 fix
- `git diff 03-settimeout 04-scheduler-yield` — a one-line difference
- `git diff 03a-microtask 03-settimeout` — the one line between "doesn't work" and
  "works"

---

## 5. Marking the code

So the changed code can be found in seconds, on any branch:

**In `00-baseline`**, the problem code sits under a marker:

```js
// 🐌 JANK — Segment 3: one long synchronous loop; the browser can't paint or take input
```

**In the fix branch**, that block is replaced by:

```js
// ⚡ FIX — Segment 3: yield with setTimeout(0) between chunks so input and paint get a turn
...
// ⚡ END FIX — Segment 3
```

Rules:

- Every line a fix branch changes is inside its `⚡ FIX` block. Nothing changes outside
  it, except new files (`worker.js`), which start with the same marker.
- The marker always says which segment and, in one plain sentence, why.
- Searching for `Segment 3` finds the spot on every branch.

---

## 6. The segments in code

### Segment 1 — `00-baseline` → `01-promise-all`

Baseline, written the way people actually write it:

```js
showSpinner();
services.forEach(async (service) => {
  const data = await service.fetch(selected);
  renderSection(service.name, data);
});
hideSpinner();   // runs immediately — forEach didn't wait
```

Fix:

```js
showSpinner();
const results = await Promise.all(services.map((s) => s.fetch(selected)));
results.forEach((data, i) => renderSection(services[i].name, data));
hideSpinner();
```

**DevTools:** Performance panel shows layout shifts in the baseline, none after.

### Segment 2 — `01-promise-all` → `02-allsettled`

Select only trials whose drugs are investigational. openFDA returns **404**, so
`Promise.all` rejects and the panel shows only an error, discarding PubMed's results.

Each service's fetch must check `res.ok` and throw — `fetch` doesn't reject on a 404 by
itself. Fix: `Promise.allSettled`, rendering each result on its own; a rejected openFDA
call shows *"No FDA label found for these drugs."*

**DevTools:** Network panel shows the 404 in both; only the fix renders PubMed's data.

### Segments 3–5 — the shared baseline

```js
// 🐌 JANK — Segment 3: one long synchronous loop; the browser can't paint or take input
for (let i = 0; i < trials.length; i++) {
  scores[i] = matchTrial(trials[i], profile);
  setProgress(i / trials.length);   // never paints until the loop ends
}
```

**Action:** click **Update matches**, then type into Medications.
**Before:** keystrokes appear in a burst at the end; the bar jumps from 0% to 100%.
**DevTools:** one long task covering all of matching.

### `03a-microtask` — doesn't help

Chunk the loop (yield after ~10ms of work) with `await Promise.resolve();`.
Still frozen, bar still jumps. **DevTools:** still one long task — every chunk is
trapped inside it.

### `03-settimeout`

Same chunking, yielding with `await new Promise((r) => setTimeout(r, 0));`.
Typing echoes, bar fills. **DevTools:** many short tasks with gaps between them.

### `04-scheduler-yield`

Same chunking, yielding with:

```js
await (globalThis.scheduler?.yield?.() ?? new Promise((r) => setTimeout(r, 0)));
```

Safari lacks `scheduler.yield()`, hence the fallback. Present in Chrome.
**DevTools:** shorter `match` bar than `03-settimeout`.

### `05-worker`

`worker.js` loads `matcher.js` with `importScripts`. After each search, post the trials
to the worker **once**; on **Update matches**, post only the profile. The worker sends
progress about every 5% and the scores at the end. One worker, reused.
**DevTools:** matching appears on the worker's own thread track.

---

## 7. Matching — `matchTrial(trial, profile)`

Lives only in `matcher.js`. Must be genuine work, never a fake delay.

1. Split the eligibility text into inclusion and exclusion parts at "Exclusion Criteria".
2. Lowercase and split each part into words.
3. For each profile medication and condition, look for it in each part **allowing up to
   2 typos** (edit distance ≤ 2). Patients misspell drug names and so do sponsors, so
   typo tolerance is a real feature — and comparing every profile term to every word
   is real CPU work.
4. Score: +1 per inclusion match, −2 per exclusion match, and −5 if the patient's age
   falls outside the trial's minimum/maximum age.

---

## 8. Data

**APIs** (all verified to work from a browser):

- ClinicalTrials.gov: `https://clinicaltrials.gov/api/v2/studies` — `query.cond` accepts
  `OR`; status filter `RECRUITING|ENROLLING_BY_INVITATION|AVAILABLE`; `pageSize` max
  1000; next page via `nextPageToken` → `pageToken`, resending the original parameters.
  Fetch at most 3 pages. Use `fields` to request only title, phase, eligibility, ages,
  intervention names, and reference PMIDs.
- openFDA: `https://api.fda.gov/drug/label.json` — one request for all selected drugs.
  Returns 404 when nothing matches.
- PubMed: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=…`
  — one request for all PMIDs.

Recruiting diabetes trials: 2,181. Measured latencies: ClinicalTrials.gov ~264ms,
openFDA ~340–405ms, PubMed ~340ms.

**Offline mode** (conference wifi): one constant at the top of `app.js`,
`const OFFLINE = false;`. When true, read the saved responses in `data/` and wait a
fixed delay per service matching the latencies above, so segment 1 still shows sections
arriving at different times. Label that wait in a comment as simulated network.

Show openFDA's disclaimer (not for medical decisions) under the drug section.

---

## 9. Measure during the build

1. **Matcher cost** — total matching time on `00-baseline`, normal and with 4× CPU
   throttling. If the freeze is under ~150ms throttled it won't be visible; report it.
2. **`setTimeout` vs `scheduler.yield()`** — `match` duration on `03` vs `04`.
3. **Worker copy** — time to post the trials to the worker.

Label phases with `performance.mark` / `performance.measure` named `search`, `enrich`,
`match`, and `worker:copy` so they show up by name in DevTools.

---

## 10. Don't build

Sorting · filters · pagination UI · routing · frameworks · modules · build tools ·
tests · error-handling beyond what segment 2 needs · retry logic · caching ·
`AbortController` · anything not in §1.
