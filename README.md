# Trial Finder

The demo app from the SeattleJS talk **"Your app isn't slow, it's badly scheduled."**
It searches ClinicalTrials.gov, fetches details for the trials you pick, and scores every trial
against a patient profile right in the browser.

It's plain HTML, CSS and JavaScript: there's no build step and nothing to install.

## Run it

```sh
git clone https://github.com/ryansoeder/seattle-js-async-talk.git
cd seattle-js-async-talk
git checkout 00-baseline
npx serve            # then open http://localhost:3000
```

No Node? Run `python3 -m http.server` instead and open http://localhost:8000.

It needs a local server: opening `index.html` straight from disk won't work, because browsers
block the `fetch` calls the app makes from `file://` pages.

## Branches

Each branch adds one fix to the branch before it. Check out the next one and reload to compare.

| Branch | What it shows |
|---|---|
| `00-baseline` | The starting point, with every problem in place |
| `01-promise-all` | Segment 1: wait for both detail requests with `Promise.all` |
| `02-allsettled` | Segment 2: `Promise.allSettled`, so one failed request doesn't hide the other |
| `03a-microtask` | Segment 3, first attempt: yielding with `await Promise.resolve()` doesn't help |
| `03-settimeout` | Segment 3: split matching into chunks and yield with `setTimeout` |
| `04-scheduler-yield` | Segment 4: yield with `scheduler.yield()` instead |
| `05-worker` | Segment 5: move matching to a Web Worker |

To find the code a segment changes, search `app.js` for "Segment 1" through "Segment 5".
Problems are marked 🐌 JANK and fixes ⚡ FIX.

## Try it

- **Segments 1 and 2:** click **Segment 1 trials** or **Segment 2 trials** to select the demo
  rows, then **Enrich selected**. The Segment 2 trials have no FDA drug label, so one of the two
  requests fails.
- **Segments 3 to 5:** click **Update matches**, then try typing in the Medications field while
  it runs.
- Record in Chrome DevTools' **Performance** panel to see the long tasks, and the `search`,
  `enrich` and `match` timings in the **Timings** track.

## Offline mode

`app.js` starts with `const OFFLINE = true;`, which replays saved responses from `data/` with a
simulated delay, so the demo works without conference Wi-Fi. Only the default "diabetes"
search and the two demo selections are saved.

Set it to `false` to call the real ClinicalTrials.gov, openFDA and PubMed APIs, so you can
search for other conditions and enrich any trials.

`scheduler.yield()` isn't available in Safari, so on that branch Safari falls back to
`setTimeout`. Use Chrome to see the difference.
