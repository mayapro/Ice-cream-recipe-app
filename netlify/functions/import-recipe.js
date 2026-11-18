// Netlify Function: POST /.netlify/functions/import-recipe  { "url": "https://..." }
//
// Fetches the page server-side (browsers can't, because of CORS), looks for the
// schema.org "Recipe" JSON-LD block most recipe sites embed for Google, and
// returns clean fields for the app's form. No AI involved, no dependencies.
//
// Required environment variables (Netlify → Site configuration → Environment variables):
//   SUPABASE_URL       e.g. https://abcdefghijk.supabase.co   (no trailing path)
//   SUPABASE_ANON_KEY  the same public anon key the app uses
// They're only used to check that the caller is a logged-in user, so this
// function can't be used as an open proxy by strangers.

const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 4;

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------- safety ----
// Because this function fetches arbitrary URLs, it must never be pointed at
// internal/private network addresses (SSRF). Every hop, including redirects,
// is checked.

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return (
      l === '::1' || l === '::' ||
      l.startsWith('::ffff:') ||
      l.startsWith('fc') || l.startsWith('fd') ||
      l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')
    );
  }
  return true;
}

async function assertPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    throw new ImportError('bad_url', "That doesn't look like a valid link.");
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ImportError('bad_url', 'Only http and https links can be imported.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new ImportError('blocked', "That address can't be imported.");
  } else {
    let addrs;
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch (e) {
      throw new ImportError('unreachable', "Couldn't find that site. Check the link and try again.");
    }
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
      throw new ImportError('blocked', "That address can't be imported.");
    }
  }
  return u;
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchHtml(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(u, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, u).toString();
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        throw new ImportError('blocked_by_site', 'That site blocked the import (some sites refuse automated requests or sit behind a paywall).');
      }
      if (!res.ok) {
        throw new ImportError('http_error', `That site returned an error (${res.status}).`);
      }
      const type = res.headers.get('content-type') || '';
      if (!/html|xml|text/i.test(type)) {
        throw new ImportError('not_html', "That link doesn't point to a web page.");
      }
      return { html: await readCapped(res), finalUrl: u.toString() };
    } catch (e) {
      if (e instanceof ImportError) throw e;
      throw new ImportError('unreachable', "Couldn't reach that site (it may be slow or blocking requests).");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ImportError('too_many_redirects', 'That link redirected too many times.');
}

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
  // Run twice: some sites double-encode (&amp;#39;).
  return decodeEntities(decodeEntities(stripped))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
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

function parseJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '')
      .replace(/^\s*\/\/\s*<!\[CDATA\[/, '')
      .replace(/\/\/\s*\]\]>\s*$/, '')
      .trim();
    try {
      blocks.push(JSON.parse(raw));
    } catch (e) {
      // Malformed block — skip it and keep looking.
    }
  }
  return blocks;
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
      const isSection = isTypeNamed(v['@type'], 'howtosection');
      const heading = isSection && v.name ? [cleanText(v.name) + ':'] : [];
      return [...heading, ...inner];
    }
    if (v.text) return flattenInstructions(v.text);
    if (v.name) return flattenInstructions(v.name);
  }
  return [];
}

function isTypeNamed(t, name) {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && x.toLowerCase().endsWith(name));
}

function stripStepNumber(line) {
  return line.replace(/^step\s*\d+\s*[.:)]?\s*/i, '').replace(/^\d+[.)]\s+/, '');
}

function normalizeYield(v) {
  if (v == null) return '';
  const list = Array.isArray(v) ? v : [v];
  const strings = list.map((x) => cleanText(x)).filter(Boolean);
  if (!strings.length) return '';
  const withWords = strings.find((s) => /[a-z]/i.test(s));
  const pick = withWords || strings[0];
  return /^\d+(\.\d+)?$/.test(pick) ? `${pick} servings` : pick;
}

function extractRecipe(html) {
  let node = null;
  for (const block of parseJsonLdBlocks(html)) {
    node = findRecipe(block);
    if (node) break;
  }
  if (!node) return null;

  const rawIngredients = node.recipeIngredient || node.ingredients || [];
  const ingredients = (Array.isArray(rawIngredients) ? rawIngredients : [rawIngredients])
    .map(cleanText)
    .filter(Boolean);

  const instructions = flattenInstructions(node.recipeInstructions)
    .map(stripStepNumber)
    .filter(Boolean);

  if (!ingredients.length && !instructions.length) return null;

  return {
    title: cleanText(node.name),
    servings: normalizeYield(node.recipeYield),
    ingredients: ingredients.join('\n'),
    instructions: instructions.join('\n'),
  };
}

// ---------------------------------------------------------------- handler ----

async function verifyLoggedIn(event) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!base || !anon) {
    return { ok: false, status: 500, message: 'The import service is not configured yet (missing SUPABASE_URL / SUPABASE_ANON_KEY on Netlify).' };
  }
  const header = event.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, message: 'Please log in again.' };
  try {
    const res = await fetch(`${base}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anon },
    });
    if (!res.ok) return { ok: false, status: 401, message: 'Your login expired. Please log in again.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 502, message: "Couldn't verify your login. Try again." };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method', message: 'Use POST.' });
  }

  const auth = await verifyLoggedIn(event);
  if (!auth.ok) return json(auth.status, { ok: false, error: 'auth', message: auth.message });

  let url = '';
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    url = String((JSON.parse(raw || '{}').url) || '').trim();
  } catch (e) {
    // fall through to the empty-url check
  }
  if (!url) return json(400, { ok: false, error: 'bad_url', message: 'Paste a link first.' });

  try {
    const { html, finalUrl } = await fetchHtml(url);
    const recipe = extractRecipe(html);
    if (!recipe) {
      return json(422, {
        ok: false,
        error: 'no_recipe',
        message: "Couldn't find a recipe on that page. Some sites don't publish their recipe in a readable format — you can paste it in manually instead.",
      });
    }
    return json(200, { ok: true, recipe: { ...recipe, source: finalUrl } });
  } catch (e) {
    if (e instanceof ImportError) {
      return json(e.code === 'unreachable' ? 502 : 400, { ok: false, error: e.code, message: e.message });
    }
    console.error('import-recipe failed', e);
    return json(500, { ok: false, error: 'server', message: 'Something went wrong importing that page.' });
  }
};

exports.extractRecipe = extractRecipe;
exports.isPrivateAddress = isPrivateAddress;
