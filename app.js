// Trial Finder: the demo app for the async scheduling talk. See DEMO-SPEC.md.
// Find the code each segment changes by searching for "Segment 1" … "Segment 5".
// The "Segment 1 trials" / "Segment 2 trials" buttons pick the demo rows: see DEMO_SELECTIONS.

// Conference wifi: set to true to replay the saved responses in data/.
const OFFLINE = true;

// Offline mode waits this long (ms) per service. openFDA ranged ~100–1,500ms live depending on
// response size; 1,200 keeps the spinner on screen long enough for the audience to see it.
const SIMULATED_LATENCY = { ctgov: 264, openfda: 1200, pubmed: 340 };

const CTGOV_URL = 'https://clinicaltrials.gov/api/v2/studies';
const OPENFDA_URL = 'https://api.fda.gov/drug/label.json';
const PUBMED_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const STATUSES = 'RECRUITING|ENROLLING_BY_INVITATION|AVAILABLE';
const FIELDS =
  'NCTId,BriefTitle,Phase,EligibilityCriteria,MinimumAge,MaximumAge,InterventionName,ReferencePMID';
const MAX_PAGES = 3;
const TOP_ROWS = 50;

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let allTrials = []; // every trial from the last search
const selectedIds = new Set(); // NCT IDs of ticked rows

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
let savedIndex = null;

async function request(service, url) {
  if (!OFFLINE) return fetch(url);
  await new Promise((r) => setTimeout(r, SIMULATED_LATENCY[service])); // simulated network
  savedIndex ??= fetch('data/index.json').then((res) => res.json());
  const index = await savedIndex;
  if (!(url in index)) console.warn('Not saved for offline mode:', url);
  // A saved 404 has no file, so the static server answers 404 as well.
  return fetch(`data/${index[url] ?? 'not-saved.json'}`);
}

// ---------------------------------------------------------------------------
// Search: one request per page. Page 2's token only exists once page 1 returns.
// ---------------------------------------------------------------------------
async function search() {
  performance.mark('search:start');
  const conditions = $('conditions').value.split(',').map((c) => c.trim()).filter(Boolean);
  const params = new URLSearchParams({
    'query.cond': conditions.join(' OR '),
    'filter.overallStatus': STATUSES,
    fields: FIELDS,
    pageSize: 1000,
  });
  allTrials = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await request('ctgov', `${CTGOV_URL}?${params}`);
    if (!res.ok) throw new Error(`ClinicalTrials.gov responded ${res.status}`);
    const body = await res.json();
    allTrials.push(...body.studies.map(toTrial));
    if (!body.nextPageToken) break;
    params.set('pageToken', body.nextPageToken);
  }
  $('status').textContent = `${allTrials.length.toLocaleString()} trials`;
  renderTable(null);
  performance.measure('search', 'search:start');
}

function toTrial({ protocolSection: p }) {
  return {
    id: p.identificationModule.nctId,
    title: p.identificationModule.briefTitle,
    phases: p.designModule?.phases ?? [],
    eligibility: p.eligibilityModule?.eligibilityCriteria ?? '',
    minAge: years(p.eligibilityModule?.minimumAge) ?? 0,
    maxAge: years(p.eligibilityModule?.maximumAge) ?? Infinity,
    interventions: (p.armsInterventionsModule?.interventions ?? []).map((i) => i.name),
    pmids: (p.referencesModule?.references ?? []).map((r) => r.pmid).filter(Boolean),
  };
}

// "18 Years", "6 Months" → years
function years(age) {
  if (!age) return null;
  const n = parseFloat(age);
  if (/month/i.test(age)) return n / 12;
  if (/week/i.test(age)) return n / 52;
  if (/day/i.test(age)) return n / 365;
  return n;
}

// ---------------------------------------------------------------------------
// Enrichment: two independent services, one request each for the whole selection
// ---------------------------------------------------------------------------
async function fetchDrugInfo(selectedTrials) {
  const names = [...new Set(selectedTrials.flatMap((t) => t.interventions))]
    .map((name) => name.replace(/\(.*?\)|["\\]|\s\d.*$/g, '').trim().toLowerCase()) // drop "(…)" and doses
    .filter((name) => name && name.length < 40 && !name.includes('placebo'));
  const terms = names.map((name) => `"${name}"`).join(' ');
  // Brand-name labels from the original packager, no combination products:
  // otherwise hundreds of generic copies crowd everything else out of one response.
  const search =
    `(openfda.generic_name:(${terms}) OR openfda.brand_name:(${terms}))` +
    ' AND openfda.application_number:(NDA* BLA*) AND openfda.is_original_packager:true' +
    ' AND NOT openfda.generic_name:and';
  const res = await request('openfda', `${OPENFDA_URL}?${new URLSearchParams({ search, limit: 20 })}`);
  if (!res.ok) throw new Error(`openFDA responded ${res.status}`); // fetch doesn't reject on a 404
  return res.json();
}

async function fetchPublications(selectedTrials) {
  const ids = [...new Set(selectedTrials.flatMap((t) => t.pmids))].slice(0, 20);
  const res = await request('pubmed', `${PUBMED_URL}?db=pubmed&retmode=json&id=${ids.join(',')}`);
  if (!res.ok) throw new Error(`PubMed responded ${res.status}`);
  const { result } = await res.json();
  return result.uids.map((uid) => result[uid]);
}

const apis = [
  { name: 'Drug information', fetchDetails: fetchDrugInfo, failMessage: 'No FDA label found for these drugs.' },
  { name: 'Publications', fetchDetails: fetchPublications, failMessage: 'Publications are unavailable right now.' },
];

async function enrichSelectedTrials() {
  const selectedTrials = allTrials.filter((trial) => selectedIds.has(trial.id));
  performance.mark('enrich:start');
  $('sections').innerHTML = '';

  // ⚡ FIX — Segment 2: Promise.allSettled waits for every outcome, so one failed service can't throw away the others
  showSpinner();
  const outcomesPerApi = await Promise.allSettled(apis.map((api) => api.fetchDetails(selectedTrials)));
  outcomesPerApi.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') renderDetailsSection(apis[i].name, outcome.value);
    else renderFailureNotice(apis[i].name, apis[i].failMessage);
  });
  hideSpinner();
  // ⚡ END FIX — Segment 2

  performance.measure('enrich', 'enrich:start');
}

// ---------------------------------------------------------------------------
// Matching: runs in the browser, so the patient's profile never leaves the device
// ---------------------------------------------------------------------------
async function updateMatches() {
  const patientProfile = readPatientProfile();
  performance.mark('match:start');
  setProgressBar(0);

  // ⚡ FIX — Segment 3: cut the loop into ~10ms chunks and yield between them, so input and paint can get a turn
  const YIELD_EVERY_MS = 10;
  const matchScores = [];
  let lastYield = performance.now();
  for (let i = 0; i < allTrials.length; i++) {
    matchScores[i] = scoreTrial(allTrials[i], patientProfile);
    if (performance.now() - lastYield > YIELD_EVERY_MS) {
      setProgressBar(i / allTrials.length);
      await Promise.resolve(); // a microtask: it runs before the browser can paint, so nothing changes
      lastYield = performance.now();
    }
  }
  // ⚡ END FIX — Segment 3

  setProgressBar(1);
  renderTable(matchScores);
  performance.measure('match', 'match:start');
}

function readPatientProfile() {
  const list = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
  return { conditions: list('conditions'), age: Number($('age').value), medications: list('medications') };
}

// ---------------------------------------------------------------------------
// Rendering. Registry and API text is third-party: always escaped.
// ---------------------------------------------------------------------------
const showSpinner = () => ($('spinner').hidden = false);
const hideSpinner = () => ($('spinner').hidden = true);
const setProgressBar = (fraction) => ($('progress').value = fraction);

function renderTable(matchScores) {
  const rows = allTrials.map((trial, i) => ({ trial, score: matchScores?.[i] }));
  if (matchScores) rows.sort((a, b) => b.score - a.score);
  $('results').innerHTML = rows
    .slice(0, TOP_ROWS)
    .map(({ trial, score }) => `<tr>
      <td><input type="checkbox" data-id="${esc(trial.id)}" ${selectedIds.has(trial.id) ? 'checked' : ''}></td>
      <td>${esc(trial.title)}</td>
      <td>${esc(formatPhases(trial.phases))}</td>
      <td>${score ?? '—'}</td>
    </tr>`)
    .join('');
}

function formatPhases(phases) {
  return phases
    .filter((p) => p !== 'NA')
    .map((p) => p.replace('EARLY_PHASE', 'Early phase ').replace('PHASE', 'Phase '))
    .join(', ') || '—';
}

const sectionBodies = {
  'Drug information': ({ results, meta }) =>
    results
      .map((label) => {
        const uses = (label.indications_and_usage?.[0] ?? '').replace(/^[\d\s]*INDICATIONS (AND|&) USAGE\s*/, '');
        return `<p><b>${esc(label.openfda.brand_name?.[0])}</b>
          <span class="muted">${esc(label.openfda.generic_name?.[0])}</span><br>
          ${esc(uses.slice(0, 220))}…</p>`;
      })
      .join('') + `<p class="disclaimer">${esc(meta.disclaimer)}</p>`,
  Publications: (docs) =>
    `<ul>${docs
      .map((doc) => `<li>${esc(doc.title)} <span class="muted">${esc(doc.source)}, ${esc(doc.pubdate?.slice(0, 4))}</span></li>`)
      .join('')}</ul>`,
};

function renderDetailsSection(name, details) {
  $('sections').insertAdjacentHTML('beforeend', `<section><h3>${esc(name)}</h3>${sectionBodies[name](details)}</section>`);
}

function renderFailureNotice(name, message) {
  $('sections').insertAdjacentHTML('beforeend', `<section><h3>${esc(name)}</h3><p>${esc(message)}</p></section>`);
}

function showEnrichError(error) {
  hideSpinner();
  $('sections').innerHTML = `<p class="error">Couldn't load details for the selection: ${esc(error.message)}</p>`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('search-button').addEventListener('click', search);
$('match-button').addEventListener('click', updateMatches);
$('enrich-button').addEventListener('click', () => enrichSelectedTrials().catch(showEnrichError));
$('results').addEventListener('change', ({ target }) => {
  if (target.checked) selectedIds.add(target.dataset.id);
  else selectedIds.delete(target.dataset.id);
});

// One click replaces the selection with a segment's demo trials. Offline mode has
// saved responses for exactly these two selections.
const DEMO_SELECTIONS = {
  'demo-1': ['NCT07512609', 'NCT06095492', 'NCT05893927'], // approved drugs: both sections load
  'demo-2': ['NCT07675499', 'NCT07861191'], // no FDA label, so openFDA answers 404
};
for (const [button, ids] of Object.entries(DEMO_SELECTIONS)) {
  $(button).addEventListener('click', () => {
    selectedIds.clear();
    ids.forEach((id) => selectedIds.add(id));
    for (const box of $('results').querySelectorAll('input')) box.checked = selectedIds.has(box.dataset.id);
  });
}

search();
