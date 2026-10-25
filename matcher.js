// matchTrial(trial, profile) → a score. Loaded by index.html, and by the worker in
// branch 05. Real work, no fake delay: every profile term is compared with every word
// of the eligibility text, allowing typos — patients and sponsors both misspell drugs.

const MAX_TYPOS = 2;

function matchTrial(trial, profile) {
  const text = trial.eligibility.toLowerCase();
  const cut = text.indexOf('exclusion criteria');
  const inclusion = words(cut === -1 ? text : text.slice(0, cut));
  const exclusion = cut === -1 ? [] : words(text.slice(cut));

  let score = 0;
  for (const term of [...profile.conditions, ...profile.medications]) {
    if (mentions(inclusion, term)) score += 1;
    if (mentions(exclusion, term)) score -= 2;
  }
  if (profile.age < trial.minAge || profile.age > trial.maxAge) score -= 5;
  return score;
}

function words(text) {
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}

// A term like "insulin glargine" matches when each of its words appears, give or take typos.
function mentions(textWords, term) {
  return term
    .toLowerCase()
    .split(/\s+/)
    .every((part) => textWords.some((word) => editDistance(word, part) <= MAX_TYPOS));
}

// Levenshtein distance: the fewest single-letter edits that turn a into b.
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitute);
    }
    previous = current;
  }
  return previous[b.length];
}
