// Numbered, checkable method steps.
//
// The method is stored as plain text, one step per line. Numbers are added
// at display time, so typed or imported numbering ("1.", "Step 2:") is removed.
//
// Check state lives in this device's localStorage, keyed by recipe id. Each
// check remembers the step text it was made against, so editing a step
// un-checks it. The whole record expires 12 hours after the last change.

const KEY_PREFIX = 'scoop-steps:';
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_HEADING_LENGTH = 60;

// Mirrors stripStepNumber in recipe-extract.js. If you change one, change both.
function stripStepNumber(line) {
  return line.replace(/^step\s*\d+\s*[.:)]?\s*/i, '').replace(/^\d+[.)]\s+/, '');
}

// Returns [{ type: 'heading', text } | { type: 'step', text }].
// A short line ending in ":" is a heading (e.g. "For the base:").
// Numbers like "1.5 cups" are kept, because a step number needs a space after it.
export function parseSteps(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => stripStepNumber(line).trim())
    .filter(Boolean)
    .map((line) => {
      if (line.endsWith(':') && line.length <= MAX_HEADING_LENGTH) return { type: 'heading', text: line };
      return { type: 'step', text: line };
    });
}

function readRecord(recipeId) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_PREFIX + recipeId) || 'null');
    if (raw && typeof raw.ts === 'number' && Date.now() - raw.ts <= TTL_MS && raw.checked) return raw;
  } catch (e) { /* unreadable or unavailable storage: treat as empty */ }
  return { ts: Date.now(), checked: {} };
}

function writeRecord(recipeId, record) {
  try {
    localStorage.setItem(KEY_PREFIX + recipeId, JSON.stringify(record));
  } catch (e) { /* storage full or disabled: checks just won't persist */ }
}

// stepNo is the step's position among steps only (headings not counted).
export function getCheckedSteps(recipeId, steps) {
  const record = readRecord(recipeId);
  const checked = new Set();
  steps.forEach((text, stepNo) => {
    if (record.checked[stepNo] === text) checked.add(stepNo);
  });
  return checked;
}

export function setStepChecked(recipeId, stepNo, text, isChecked) {
  const record = readRecord(recipeId);
  if (isChecked) record.checked[stepNo] = text;
  else delete record.checked[stepNo];
  record.ts = Date.now();
  writeRecord(recipeId, record);
}

export function clearStepChecks(recipeId) {
  try { localStorage.removeItem(KEY_PREFIX + recipeId); } catch (e) { /* ignore */ }
}
