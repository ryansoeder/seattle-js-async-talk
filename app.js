// Trial Finder: the demo app for the async scheduling talk. See DEMO-SPEC.md.
// Find the code each segment changes by searching for "Segment 1" … "Segment 5".
// Demo selections (tick these rows before clicking Enrich selected):
//   Segment 1: NCT07512609, NCT06095492, NCT05893927 (approved drugs: both sections load)
//   Segment 2: NCT07675499, NCT07861191 (no FDA label, so openFDA answers 404)

// Conference wifi: set to true to replay the saved responses in data/.
const OFFLINE = false;

// Offline mode waits this long (ms) per service: the measured live latencies.
const SIMULATED_LATENCY = { ctgov: 264, openfda: 405, pubmed: 340 };

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

let trials = [];
const selected = new Set(); // NCT IDs of ticked rows

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
  trials = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await request('ctgov', `${CTGOV_URL}?${params}`);
    if (!res.ok) throw new Error(`ClinicalTrials.gov responded ${res.status}`);
    const body = await res.json();
    trials.push(...body.studies.map(toTrial));
    if (!body.nextPageToken) break;
    params.set('pageToken', body.nextPageToken);
  }
  $('status').textContent = `${trials.length.toLocaleString()} trials`;
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
async function fetchDrugInfo(trials) {
  const names = [...new Set(trials.flatMap((t) => t.interventions))]
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

async function fetchPublications(trials) {
  const ids = [...new Set(trials.flatMap((t) => t.pmids))].slice(0, 20);
  const res = await request('pubmed', `${PUBMED_URL}?db=pubmed&retmode=json&id=${ids.join(',')}`);
  if (!res.ok) throw new Error(`PubMed responded ${res.status}`);
  const { result } = await res.json();
  return result.uids.map((uid) => result[uid]);
}

const services = [
  { name: 'Drug information', fetch: fetchDrugInfo, failMessage: 'No FDA label found for these drugs.' },
  { name: 'Publications', fetch: fetchPublications, failMessage: 'Publications are unavailable right now.' },
];

async function enrichSelected() {
  const chosen = trials.filter((t) => selected.has(t.id));
  performance.mark('enrich:start');
  $('sections').innerHTML = '';

  // 🐌 JANK — Segment 1: forEach doesn't wait for async callbacks, so the spinner hides at once and sections land one by one
  // (Segment 2 starts from Segment 1's fix.)
  showSpinner();
  services.forEach(async (service) => {
    const data = await service.fetch(chosen);
    renderSection(service.name, data);
  });
  hideSpinner(); // runs immediately — forEach didn't wait
  // 🐌 END JANK — Segment 1

  performance.measure('enrich', 'enrich:start');
}

// ---------------------------------------------------------------------------
// Matching: runs in the browser, so the patient's profile never leaves the device
// ---------------------------------------------------------------------------
async function updateMatches() {
  const profile = readProfile();
  performance.mark('match:start');
  setProgress(0);

  // 🐌 JANK — Segment 3: one long synchronous loop; the browser can't paint or take input
  // (Segment 4 and Segment 5 fix this same loop.)
  const scores = [];
  for (let i = 0; i < trials.length; i++) {
    scores[i] = matchTrial(trials[i], profile);
    setProgress(i / trials.length); // never paints until the loop ends
  }
  // 🐌 END JANK — Segment 3

  setProgress(1);
  renderTable(scores);
  performance.measure('match', 'match:start');
}

function readProfile() {
  const list = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
  return { conditions: list('conditions'), age: Number($('age').value), medications: list('medications') };
}

// ---------------------------------------------------------------------------
// Rendering. Registry and API text is third-party: always escaped.
// ---------------------------------------------------------------------------
const showSpinner = () => ($('spinner').hidden = false);
const hideSpinner = () => ($('spinner').hidden = true);
const setProgress = (fraction) => ($('progress').value = fraction);

function renderTable(scores) {
  const rows = trials.map((trial, i) => ({ trial, score: scores?.[i] }));
  if (scores) rows.sort((a, b) => b.score - a.score);
  $('results').innerHTML = rows
    .slice(0, TOP_ROWS)
    .map(({ trial, score }) => `<tr>
      <td><input type="checkbox" data-id="${esc(trial.id)}" ${selected.has(trial.id) ? 'checked' : ''}></td>
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

function renderSection(name, data) {
  $('sections').insertAdjacentHTML('beforeend', `<section><h3>${esc(name)}</h3>${sectionBodies[name](data)}</section>`);
}

function renderNotice(name, message) {
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
$('enrich-button').addEventListener('click', () => enrichSelected().catch(showEnrichError));
$('results').addEventListener('change', ({ target }) => {
  if (target.checked) selected.add(target.dataset.id);
  else selected.delete(target.dataset.id);
});

search();
