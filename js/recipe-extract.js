// Used by the bookmarklet import: the bookmark sends the recipe page's raw
// JSON-LD blocks to the app, and everything below turns them into form fields.
//
// NOTE: the extraction logic mirrors netlify/functions/import-recipe.js (that
// one runs server-side, this one in the browser). If you improve one, update the other.

// ------------------------------------------------------------ extraction ----

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', deg: '°',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  frac12: '½', frac14: '¼', frac34: '¾',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (err) { return m; }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function cleanText(v) {
  if (v == null) return '';
  const stripped = String(v)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(decodeEntities(stripped))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function isTypeNamed(t, name) {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && x.toLowerCase().endsWith(name));
}

function isRecipeType(t) {
  const types = Array.isArray(t) ? t : [t];
  return types.some(
    (x) => typeof x === 'string' && x.toLowerCase().replace(/^https?:\/\/schema\.org\//, '') === 'recipe'
  );
}

function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (isRecipeType(node['@type'])) return node;
  for (const key of Object.keys(node)) {
    const r = findRecipe(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

function flattenInstructions(v) {
  if (!v) return [];
  if (typeof v === 'string') {
    return cleanText(v).split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(v)) return v.flatMap(flattenInstructions);
  if (typeof v === 'object') {
    if (v.itemListElement) {
      const inner = flattenInstructions(v.itemListElement);
      const heading = isTypeNamed(v['@type'], 'howtosection') && v.name ? [cleanText(v.name) + ':'] : [];
      return [...heading, ...inner];
    }
    if (v.text) return flattenInstructions(v.text);
    if (v.name) return flattenInstructions(v.name);
  }
  return [];
}

function stripStepNumber(line) {
  return line.replace(/^step\s*\d+\s*[.:)]?\s*/i, '').replace(/^\d+[.)]\s+/, '');
}

function normalizeYield(v) {
  if (v == null) return '';
  const list = Array.isArray(v) ? v : [v];
  const strings = list.map((x) => cleanText(x)).filter(Boolean);
  if (!strings.length) return '';
  const pick = strings.find((s) => /[a-z]/i.test(s)) || strings[0];
  return /^\d+(\.\d+)?$/.test(pick) ? `${pick} servings` : pick;
}

function parseBlock(text) {
  const raw = String(text)
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\s*\/\/\s*<!\[CDATA\[/, '')
    .replace(/\/\/\s*\]\]>\s*$/, '')
    .trim();
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// blocks: array of raw JSON-LD strings. Returns {title, servings, ingredients, instructions} or null.
export function extractRecipeFromJsonLd(blocks) {
  let node = null;
  for (const text of blocks) {
    const parsed = parseBlock(text);
    node = parsed && findRecipe(parsed);
    if (node) break;
  }
  if (!node) return null;

  const rawIngredients = node.recipeIngredient || node.ingredients || [];
  const ingredients = (Array.isArray(rawIngredients) ? rawIngredients : [rawIngredients])
    .map(cleanText)
    .filter(Boolean);
  const instructions = flattenInstructions(node.recipeInstructions).map(stripStepNumber).filter(Boolean);
  if (!ingredients.length && !instructions.length) return null;

  return {
    title: cleanText(node.name),
    servings: normalizeYield(node.recipeYield),
    ingredients: ingredients.join('\n'),
    instructions: instructions.join('\n'),
  };
}

// ------------------------------------------------------------- bookmarklet ----

// The bookmark runs on the recipe page. It collects only the JSON-LD blocks
// that mention "Recipe", and opens the app with them in the URL hash (a hash
// is never sent to any server). Kept deliberately small: all the real work
// happens in the app, so improvements don't require reinstalling the bookmark.
function bookmarkletSource(origin) {
  const target = JSON.stringify(origin + '/#import=');
  return `(function(){
var b=[].slice.call(document.querySelectorAll('script[type="application/ld+json"]')).map(function(s){return s.textContent}).filter(function(t){return /Recipe/.test(t)});
if(!b.length){alert('Scoop Journal: no recipe data found on this page.');return}
var j=JSON.stringify({u:location.href,b:b});
if(j.length>300000){alert('Scoop Journal: the recipe data on this page is too large to send.');return}
var p=btoa(unescape(encodeURIComponent(j))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
var u=${target}+p;
if(!window.open(u,'_blank'))location.href=u;
})();`;
}

export function buildBookmarkletHref(origin) {
  const minified = bookmarkletSource(origin).replace(/\n/g, '');
  return 'javascript:' + encodeURIComponent(minified);
}

// Reverses what the bookmarklet encoded. Throws if the payload is damaged.
export function decodeImportPayload(raw) {
  const b64 = String(raw).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || !Array.isArray(data.b)) throw new Error('bad payload');
  return { url: String(data.u || ''), blocks: data.b.filter((x) => typeof x === 'string') };
}
