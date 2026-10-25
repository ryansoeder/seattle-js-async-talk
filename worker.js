/*
 * worker.js — the eligibility matcher.
 *
 * This one file is loaded two ways:
 *   1. As a classic <script> by index.html. The baseline and segments 3–4 call
 *      matchTrial() on the main thread.
 *   2. As a Web Worker (segment 5). The same matchTrial() runs on its own thread.
 * Every segment schedules this one function. None gets its own matcher.
 *
 * The matcher is not clinically meaningful, but it is real work: it tokenizes
 * sponsor-written prose, splits inclusion from exclusion, handles negation,
 * extracts age ranges, and scores term overlap. There is no artificial delay.
 */

const STOPWORDS = new Set((
  'a an and are as at be been by for from has have in is it its of on or the to ' +
  'with who whom which will may must should can any all other such than that this ' +
  'these those within least patients patient participants participant subjects ' +
  'subject study history diagnosis diagnosed known current currently prior ' +
  'previous previously including include defined following'
).split(' '));

// Words that negate what follows, until a clause boundary or NEGATION_SCOPE terms.
const NEGATION_CUES = new Set([
  'no', 'not', 'without', 'never', 'none', 'absence', 'free', 'negative', 'neither', 'nor',
]);
const NEGATION_SCOPE = 5;

const ABBREVIATIONS = {
  t2dm: 'type 2 diabetes', t2d: 'type 2 diabetes', t1dm: 'type 1 diabetes',
  t1d: 'type 1 diabetes', dm: 'diabetes', ckd: 'chronic kidney disease',
  esrd: 'end stage kidney disease', eskd: 'end stage kidney disease',
  htn: 'hypertension', mi: 'myocardial infarction', chf: 'heart failure',
  hf: 'heart failure', copd: 'chronic obstructive pulmonary disease',
  egfr: 'estimated glomerular filtration rate',
};

const SYNONYMS = { renal: 'kidney', nephropathy: 'kidney disease' };

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/≥/g, ' >= ')
    .replace(/≤/g, ' <= ')
    .replace(/\\([[\]])/g, '$1'); // the registry escapes brackets as \[ \]
}

// Light suffix stripping so "diabetes"/"diabetic" and "hypertension"/"hypertensive" meet.
function stem(word) {
  if (word.length < 4 || /\d/.test(word)) return word;
  let w = word;
  if (w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  w = w.replace(/(?:ation|ment|ing|ive|ion|ic|ed|al)$/, (suffix, at) => (at >= 4 ? '' : suffix));
  return w.replace(/e$/, '');
}

function expand(word) {
  const full = ABBREVIATIONS[word] ?? SYNONYMS[word];
  return full ? full.split(' ') : [word];
}

// One criterion → the terms it mentions, split by whether they sit under a negation.
function analyzeCriterion(text) {
  const positive = new Set();
  const negated = new Set();
  let termCount = 0;
  let negatedUntil = -1;

  for (const token of normalizeText(text).match(/[a-z0-9]+|[;,:()]/g) ?? []) {
    if (/^[;,:()]$/.test(token)) {
      negatedUntil = -1; // a clause boundary ends the negation
      continue;
    }
    if (NEGATION_CUES.has(token)) {
      negatedUntil = termCount + NEGATION_SCOPE;
      continue;
    }
    for (const word of expand(token)) {
      if (STOPWORDS.has(word) || (word.length < 2 && !/\d/.test(word))) continue;
      (termCount < negatedUntil ? negated : positive).add(stem(word));
      termCount++;
    }
  }
  return { positive, negated };
}

// Sponsors write "Inclusion Criteria:" / "Exclusion Criteria:" headings, then bullets.
function splitCriteria(text) {
  const inclusion = [];
  const exclusion = [];
  let section = inclusion;

  for (const raw of text.split(/\n+/)) {
    let line = raw.replace(/^\s*(?:[*\-•]|\d{1,2}[.)])\s*/, '').trim();
    const heading = line.match(/^(?:key\s+)?(inclusion|exclusion)\s+criteria\s*:?\s*/i);
    if (heading) {
      section = heading[1].toLowerCase() === 'inclusion' ? inclusion : exclusion;
      line = line.slice(heading[0].length);
    }
    if (line) section.push(line);
  }
  return { inclusion, exclusion };
}

const AGE_CONTEXT = /\bage[ds]?\b|\byears? (?:old|of age)\b/;
const AGE_RANGE = [
  /\bage[ds]?\s*(?:between|from|of)?\s*(\d{1,3})\s*(?:-|–|to|and)\s*(\d{1,3})\b/,
  /\b(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:years|yrs)\b/,
  /\bbetween\s*(?:the\s*ages?\s*of\s*)?(\d{1,3})\s*and\s*(\d{1,3})\b/,
];
const AGE_MIN = [
  /\bage[ds]?\s*(?:>=|>|over|above|at least|older than|of at least)\s*(\d{1,3})\b/,
  /\b(\d{1,3})\s*(?:years?|yrs)\s*(?:of age|old)?\s*(?:or|and)\s*(?:older|over|above)\b/,
  /(?:>=|>)\s*(\d{1,3})\s*(?:years|yrs)\b/,
];
const AGE_MAX = [
  /\bage[ds]?\s*(?:<=|<|under|below|younger than|less than|up to)\s*(\d{1,3})\b/,
  /(?:<=|<)\s*(\d{1,3})\s*(?:years|yrs)\b/,
  /\b(?:under|younger than|below)\s*(\d{1,3})\s*(?:years|yrs)\b/,
];

const firstMatch = (patterns, line) => {
  for (const pattern of patterns) {
    const m = line.match(pattern);
    if (m) return m;
  }
  return null;
};

function extractAgeRange(inclusion) {
  let min = null;
  let max = null;
  for (const raw of inclusion) {
    const line = normalizeText(raw);
    if (!AGE_CONTEXT.test(line)) continue;
    const range = firstMatch(AGE_RANGE, line);
    if (range) [min, max] = [min ?? +range[1], max ?? +range[2]];
    min ??= firstMatch(AGE_MIN, line)?.[1] ?? null;
    max ??= firstMatch(AGE_MAX, line)?.[1] ?? null;
    if (min != null && max != null) break;
  }
  if (min == null && max == null) return null;
  const range = { min: Number(min ?? 0), max: Number(max ?? 120) };
  return range.min <= range.max && range.max <= 120 ? range : null;
}

function extractSex(inclusion) {
  let female = false;
  let male = false;
  for (const raw of inclusion) {
    const line = raw.toLowerCase();
    // Pregnancy and contraception lines apply to anyone who could become pregnant;
    // they aren't a sex restriction.
    if (/pregnan|childbearing|contracept|lactat|breast-?feed/.test(line)) continue;
    if (/\b(?:women|woman|females?|postmenopausal)\b/.test(line)) female = true;
    if (/\b(?:men|man|males?)\b/.test(line)) male = true;
  }
  if (female !== male) return female ? 'female' : 'male';
  return null;
}

// The profile is tokenized once per run, not once per trial.
const profileTermsCache = new WeakMap();

function profileTerms(profile) {
  let terms = profileTermsCache.get(profile);
  if (!terms) {
    const phrases = (list) =>
      list
        .map((label) => ({ label, stems: [...analyzeCriterion(label).positive] }))
        .filter((phrase) => phrase.stems.length);
    terms = {
      conditions: phrases(profile.conditions),
      treatments: phrases([...profile.medications, ...profile.priorTreatments]),
    };
    terms.all = [...terms.conditions, ...terms.treatments];
    profileTermsCache.set(profile, terms);
  }
  return terms;
}

// Fraction of a phrase's terms present in a set of terms.
function overlap(phrase, terms) {
  let found = 0;
  for (const s of phrase.stems) if (terms.has(s)) found++;
  return found / phrase.stems.length;
}

function formatAges({ min, max }) {
  return max >= 120 ? `Ages ${min}+` : `Ages ${min}–${max}`;
}

/**
 * Score one trial against the patient's profile.
 * Returns { score: 0–100, eligible, note }.
 */
function matchTrial(trial, profile) {
  const terms = profileTerms(profile);
  const { inclusion, exclusion } = splitCriteria(trial.criteria);

  // Hard gates: age range and sex, read from the prose.
  const ages = extractAgeRange(inclusion);
  if (ages && profile.age != null && (profile.age < ages.min || profile.age > ages.max)) {
    return { score: 0, eligible: false, note: formatAges(ages) };
  }
  const sex = extractSex(inclusion);
  if (sex && profile.sex && sex !== profile.sex) {
    return { score: 0, eligible: false, note: sex === 'female' ? 'Women only' : 'Men only' };
  }

  const included = inclusion.map(analyzeCriterion);
  const excluded = exclusion.map(analyzeCriterion);
  const listed = analyzeCriterion(trial.conditions.join('; ')).positive;

  // How well does each of the patient's conditions appear in what the trial asks for?
  let conditionFit = 0;
  for (const phrase of terms.conditions) {
    let best = overlap(phrase, listed);
    for (const c of included) best = Math.max(best, overlap(phrase, c.positive));
    conditionFit += best;
  }
  conditionFit /= terms.conditions.length || 1;

  // Anything the patient has, takes, or has had that the trial rules out:
  // mentioned in an exclusion, or negated in an inclusion ("no history of …").
  const hits = new Set();
  for (const phrase of terms.all) {
    if (excluded.some((c) => overlap(phrase, c.positive) === 1)) hits.add(phrase.label);
    if (included.some((c) => overlap(phrase, c.negated) === 1)) hits.add(phrase.label);
  }

  // Inclusions that ask for the patient's treatments, e.g. "on stable metformin".
  let treatmentFit = 0;
  for (const phrase of terms.treatments) {
    if (included.some((c) => overlap(phrase, c.positive) === 1)) treatmentFit++;
  }
  treatmentFit = Math.min(1, treatmentFit / 2);

  const raw = 100 * (0.8 * conditionFit + 0.2 * treatmentFit) - 25 * hits.size;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  const note = hits.size ? `Excludes ${[...hits].join(', ')}` : ages ? formatAges(ages) : '';
  return { score, eligible: hits.size === 0, note };
}

// ---------------------------------------------------------------------------
// SEGMENT 5: when this file runs as a worker.
// A worker has its own call stack and event loop, and it cannot touch the DOM.
// It only computes; the main thread renders whatever it posts back.
// ---------------------------------------------------------------------------
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let trials = []; // posted once per search, kept for every run after that

  self.onmessage = ({ data }) => {
    if (data.type === 'trials') {
      trials = data.trials;
      return;
    }
    if (data.type === 'match') {
      const { run, profile } = data;
      const total = trials.length;
      const every = Math.max(1, Math.round(total / 20)); // progress about every 5%
      const results = [];
      for (let i = 0; i < total; i++) {
        results.push(matchTrial(trials[i], profile));
        if ((i + 1) % every === 0) postMessage({ type: 'progress', run, done: i + 1, total });
      }
      postMessage({ type: 'results', run, results });
    }
  };
}
