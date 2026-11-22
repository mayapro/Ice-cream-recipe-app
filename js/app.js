import { getSession, onAuthChange, sendMagicLink, signOut } from './auth.js';
import {
  subscribeToRecipes, saveRecipe, deleteRecipe,
  addBatchEntry, removeBatchEntry, uploadPhoto,
  getPendingSyncCount, syncOutbox, importRecipeFromUrl,
} from './data.js';
import { parseSteps, getCheckedSteps, setStepChecked, clearStepChecks } from './steps.js';
import { extractRecipeFromJsonLd, buildBookmarkletHref, decodeImportPayload } from './recipe-extract.js';

const CATEGORIES = ["Custard base", "Philadelphia base", "Sorbet", "Gelato", "Vegan / dairy-free", "Mix-in / swirl", "Other"];

let session = null;
let recipes = [];
let unsubscribeRecipes = null;

let state = {
  view: 'list',
  search: '',
  filterTag: null,
  currentId: null,
  form: null,
  pendingPhotos: [],
  isOnline: navigator.onLine,
  pendingSyncCount: 0,
};

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (e) { return d; }
}

function starsHTML(rating) {
  rating = rating || 0;
  let s = '<span class="stars">';
  for (let i = 1; i <= 5; i++) s += i <= rating ? '★' : '<span class="off">★</span>';
  return s + '</span>';
}

function escapeHTML(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
const escapeAttr = escapeHTML;

// ---------------- Boot ----------------
// ---------------- Bookmarklet hand-off ----------------
// The bookmark opens this app with "#import=<data>". We read it once, clear it
// from the address bar, and hold the result until the user is logged in.
const PENDING_IMPORT_KEY = 'scoop-pending-import';
const PENDING_IMPORT_MAX_AGE_MS = 30 * 60 * 1000;
let pendingImportMemory = null;

function readPendingImport() {
  let p = pendingImportMemory;
  if (!p) {
    try { p = JSON.parse(localStorage.getItem(PENDING_IMPORT_KEY) || 'null'); } catch (e) { p = null; }
  }
  if (!p || Date.now() - p.ts > PENDING_IMPORT_MAX_AGE_MS) { clearPendingImport(); return null; }
  return p;
}

function clearPendingImport() {
  pendingImportMemory = null;
  try { localStorage.removeItem(PENDING_IMPORT_KEY); } catch (e) { /* ignore */ }
}

function captureImportFromHash() {
  const m = location.hash.match(/^#import=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let pending;
  try {
    const { url, blocks } = decodeImportPayload(m[1]);
    const recipe = extractRecipeFromJsonLd(blocks);
    pending = recipe
      ? { ts: Date.now(), url, recipe }
      : { ts: Date.now(), url, error: "Couldn't find a readable recipe on that page." };
  } catch (e) {
    pending = { ts: Date.now(), error: 'That import was damaged. Try the bookmark again.' };
  }
  pendingImportMemory = pending;
  try { localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(pending)); } catch (e) { /* memory copy still works */ }
}

function applyPendingImport() {
  const p = readPendingImport();
  if (!p) return;
  clearPendingImport();
  if (p.error || !p.recipe) { toast(p.error || 'Import failed.'); return; }
  openNewForm({
    title: p.recipe.title || '',
    servings: p.recipe.servings || '',
    source: p.url || '',
    ingredients: p.recipe.ingredients || '',
    instructions: p.recipe.instructions || '',
  });
  let host = '';
  try { host = new URL(p.url).hostname.replace(/^www\./, ''); } catch (e) { /* no host */ }
  toast(host ? `Imported from ${host}. Review and adjust before saving.` : 'Imported. Review and adjust before saving.');
}

async function boot() {
  session = await getSession();
  onAuthChange((newSession) => {
    const wasLoggedIn = !!session;
    session = newSession;
    if (!!session !== wasLoggedIn) {
      if (session) startDataSync(); else stopDataSync();
      render();
      if (session) applyPendingImport();
    }
  });
  if (session) startDataSync();
  render();
  if (session) applyPendingImport();

  window.addEventListener('online', async () => {
    state.isOnline = true;
    if (session) await syncOutbox(session.user.id);
    await refreshPendingCount();
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    renderIfSafe();
  });
  refreshPendingCount();
  setInterval(refreshPendingCount, 15000);
}

// Background events (sync ticks, connectivity changes) should never blow
// away an in-progress add/edit form by re-rendering over it mid-keystroke.
function renderIfSafe() {
  if (state.view !== 'form') render();
}

async function refreshPendingCount() {
  try {
    state.pendingSyncCount = await getPendingSyncCount();
  } catch (e) { /* ignore */ }
  renderIfSafe();
}

function startDataSync() {
  if (unsubscribeRecipes) unsubscribeRecipes();
  unsubscribeRecipes = subscribeToRecipes(session.user.id, (data) => {
    recipes = data;
    render();
  });
}
function stopDataSync() {
  if (unsubscribeRecipes) unsubscribeRecipes();
  unsubscribeRecipes = null;
  recipes = [];
}

// ---------------- Navigation ----------------
function goList() { state.view = 'list'; state.currentId = null; render(); }
function goDetail(id) { state.view = 'detail'; state.currentId = id; render(); window.scrollTo(0, 0); }
function openNewForm(prefill) {
  state.view = 'form';
  state.form = { title: '', category: CATEGORIES[0], source: '', servings: '', ingredients: '', instructions: '', tweaks: '', tags: '', rating: 0, photo_paths: [], ...prefill };
  state.pendingPhotos = [];
  render(); window.scrollTo(0, 0);
}
// Kept argument-free on purpose: it's used directly as a click handler.
function goNewForm() { openNewForm({}); }
function goEditForm(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) return;
  state.view = 'form';
  state.form = { ...r, tags: (r.tags || []).join(', ') };
  state.pendingPhotos = (r.photo_paths || []).map((path, i) => ({ path, url: recipePhotoUrl(r, i) }));
  render(); window.scrollTo(0, 0);
}
function recipePhotoUrl(r, i) {
  // photo_paths and a parallel array of public urls aren't both stored;
  // we rebuild the public URL from the path deterministically via Supabase.
  return window.__photoUrl(r.photo_paths[i]);
}

// ---------------- Render root ----------------
function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  if (!session) { app.appendChild(renderLogin()); return; }
  const banner = renderStatusBanner();
  if (banner) app.appendChild(banner);
  if (state.view === 'list') app.appendChild(renderList());
  else if (state.view === 'detail') app.appendChild(renderDetail());
  else if (state.view === 'form') app.appendChild(renderForm());
}

function renderStatusBanner() {
  if (!state.isOnline) {
    return el(`<div class="banner">You're offline. Changes you make now will save on this device and sync automatically once you're back online.</div>`);
  }
  if (state.pendingSyncCount > 0) {
    return el(`<div class="banner">Syncing ${state.pendingSyncCount} change${state.pendingSyncCount === 1 ? '' : 's'} made while offline…</div>`);
  }
  return null;
}

// ---------------- Login ----------------
function renderLogin() {
  const wrap = el(`
    <div class="login-screen">
      <div class="mark"></div>
      <h1>Scoop Journal</h1>
      <div class="sub">Your homemade ice cream recipes, notes and tweaks — synced across your devices.</div>
      <form class="login-form" id="login-form">
        <input type="email" id="login-email" placeholder="you@email.com" required>
        <button type="submit" id="login-btn">Send me a login link</button>
      </form>
      <div class="login-note" id="login-note">We'll email you a one-time link — no password to remember.</div>
    </div>
  `);
  if (readPendingImport()) {
    wrap.querySelector('.sub').textContent = 'Log in to finish importing your recipe.';
  }
  wrap.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = wrap.querySelector('#login-email').value.trim();
    const btn = wrap.querySelector('#login-btn');
    const note = wrap.querySelector('#login-note');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await sendMagicLink(email);
      note.textContent = `Check ${email} for a link to sign in.`;
    } catch (err) {
      console.error(err);
      note.textContent = "Couldn't send that — check the email and try again.";
      btn.disabled = false; btn.textContent = 'Send me a login link';
    }
  });
  return wrap;
}

// ---------------- List ----------------
function renderList() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`
    <div class="top">
      <div class="brand">
        <div class="mark"></div>
        <h1>Scoop Journal</h1>
        <div class="sub">${recipes.length ? recipes.length + ' recipe' + (recipes.length === 1 ? '' : 's') + ' in the freezer' : 'Your homemade ice cream lab'}</div>
      </div>
      <div class="header-actions">
        <button class="new-btn" id="new-btn">+ New recipe</button>
        <button class="logout-btn" id="logout-btn">Log out</button>
      </div>
    </div>
  `));

  const allTags = Array.from(new Set(recipes.flatMap(r => r.tags || []))).sort();
  const controls = el(`<div class="controls"></div>`);
  controls.appendChild(el(`<input class="search" id="search-input" placeholder="Search recipes, ingredients, notes…" value="${escapeAttr(state.search)}">`));
  if (allTags.length) {
    const chips = el(`<div class="chips"></div>`);
    chips.appendChild(el(`<button class="chip ${!state.filterTag ? 'active' : ''}" data-tag="">All</button>`));
    allTags.forEach(t => chips.appendChild(el(`<button class="chip ${state.filterTag === t ? 'active' : ''}" data-tag="${escapeAttr(t)}">${escapeHTML(t)}</button>`)));
    controls.appendChild(chips);
  }
  wrap.appendChild(controls);

  const q = state.search.trim().toLowerCase();
  let filtered = recipes.filter(r => {
    if (state.filterTag && !(r.tags || []).includes(state.filterTag)) return false;
    if (!q) return true;
    const hay = [r.title, r.category, r.ingredients, r.instructions, r.tweaks, (r.tags || []).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });

  if (!recipes.length) {
    wrap.appendChild(el(`
      <div class="empty">
        <div class="display">Nothing in the freezer yet</div>
        <div>Add the first recipe you're working on — you can tweak it every time you make a batch.</div>
        <button id="empty-new-btn">Add your first recipe</button>
      </div>
    `));
  } else if (!filtered.length) {
    wrap.appendChild(el(`<div class="empty"><div class="display">No matches</div><div>Try a different search or filter.</div></div>`));
  } else {
    const list = el(`<div class="recipe-list"></div>`);
    filtered.forEach(r => {
      const photo = r.photo_paths && r.photo_paths[0] ? `<img class="r-photo" src="${window.__photoUrl(r.photo_paths[0])}" alt="">` : `<div class="r-photo">🍨</div>`;
      const lastBatch = (r.batches || [])[r.batches.length - 1];
      const row = el(`
        <div class="recipe-row" data-id="${r.id}">
          ${photo}
          <div class="r-body">
            <div class="r-title">${escapeHTML(r.title || 'Untitled')}</div>
            <div class="r-cat">${escapeHTML(r.category || '')}</div>
            <div class="r-meta">${starsHTML(r.rating)}${lastBatch ? `<span>· last made ${fmtDate(lastBatch.date)}</span>` : ''}</div>
            ${(r.tags || []).length ? `<div class="r-tags">${r.tags.map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</div>` : ''}
          </div>
        </div>
      `);
      row.addEventListener('click', () => goDetail(r.id));
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }

  wrap.querySelector('#new-btn').addEventListener('click', goNewForm);
  const emptyBtn = wrap.querySelector('#empty-new-btn');
  if (emptyBtn) emptyBtn.addEventListener('click', goNewForm);
  wrap.querySelector('#search-input').addEventListener('input', (e) => { state.search = e.target.value; render(); preserveFocus('search-input'); });
  wrap.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { state.filterTag = c.dataset.tag || null; render(); }));

  return wrap;
}

function preserveFocus(id) {
  const node = document.getElementById(id);
  if (node) { node.focus(); const v = node.value; node.value = ''; node.value = v; }
}

// The source field is free text ("Salt & Straw cookbook") or a web address.
// Only a whole-field http(s) address becomes a link; anything else stays plain text.
function sourceHTML(source) {
  const text = String(source).trim();
  const candidate = /^www\./i.test(text) ? 'https://' + text : text;
  if (/^https?:\/\/\S+$/i.test(candidate)) {
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const label = u.hostname.replace(/^www\./, '');
        return `<a href="${escapeAttr(u.href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(u.href)}">${escapeHTML(label)}</a>`;
      }
    } catch (e) { /* not a valid address: show as text */ }
  }
  return escapeHTML(text);
}

// ---------------- Detail ----------------
function renderDetail() {
  const r = recipes.find(x => x.id === state.currentId);
  if (!r) { goList(); return el('<div></div>'); }
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<button class="back" id="back-btn">← All recipes</button>`));

  const head = el(`<div class="detail-head"></div>`);
  head.appendChild(el(`
    <div class="detail-title-row">
      <div>
        <div class="detail-title display">${escapeHTML(r.title || 'Untitled')}</div>
        <div class="detail-cat">${escapeHTML(r.category || '')}</div>
        ${r.source ? `<div class="detail-source">from ${sourceHTML(r.source)}</div>` : ''}
        <div class="detail-stars">${starsHTML(r.rating)}</div>
      </div>
      <div class="detail-row-actions"><button class="icon-btn" id="edit-btn" title="Edit">✎</button></div>
    </div>
  `));
  if (r.photo_paths && r.photo_paths.length) {
    const photos = el(`<div class="detail-photos"></div>`);
    r.photo_paths.forEach(p => photos.appendChild(el(`<img src="${window.__photoUrl(p)}" alt="">`)));
    head.appendChild(photos);
  }
  if ((r.tags || []).length) head.appendChild(el(`<div class="r-tags" style="margin-top:14px">${r.tags.map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</div>`));
  wrap.appendChild(head);

  if (r.servings) wrap.appendChild(el(`<div class="servings-line">Makes about ${escapeHTML(r.servings)}</div>`));
  if (r.ingredients) { const s = el(`<div class="section"><h3>Ingredients</h3></div>`); s.appendChild(el(`<div class="prose">${escapeHTML(r.ingredients)}</div>`)); wrap.appendChild(s); }
  if (r.instructions) wrap.appendChild(renderMethod(r));
  if (r.tweaks) { const s = el(`<div class="section"><h3>My tweaks</h3></div>`); s.appendChild(el(`<div class="prose">${escapeHTML(r.tweaks)}</div>`)); wrap.appendChild(s); }

  const logSec = el(`<div class="section"><h3>Batch notes</h3></div>`);
  const batches = r.batches || [];
  if (batches.length) {
    const list = el(`<div></div>`);
    [...batches].reverse().forEach((b) => {
      list.appendChild(el(`
        <div class="batch-entry">
          <div class="batch-top">
            <div class="batch-date">${fmtDate(b.date)} ${b.rating ? starsHTML(b.rating) : ''}</div>
            <button class="del-batch" data-date="${escapeAttr(b.date)}">remove</button>
          </div>
          ${b.note ? `<div class="batch-note">${escapeHTML(b.note)}</div>` : ''}
        </div>
      `));
    });
    logSec.appendChild(list);
  } else {
    logSec.appendChild(el(`<div style="color:var(--ink-soft);font-size:0.9rem">No batches logged yet. Add one after your next scoop.</div>`));
  }

  const addLog = el(`
    <div class="add-log">
      <textarea id="batch-note" placeholder="How did this batch turn out? What would you change next time?"></textarea>
      <div class="add-log-foot">
        <div class="star-picker" id="batch-stars">${[1,2,3,4,5].map(i => `<span data-v="${i}">★</span>`).join('')}</div>
        <button class="mini-btn" id="add-batch-btn">Log this batch</button>
      </div>
    </div>
  `);
  logSec.appendChild(addLog);
  wrap.appendChild(logSec);

  wrap.querySelector('#back-btn').addEventListener('click', goList);
  wrap.querySelector('#edit-btn').addEventListener('click', () => goEditForm(r.id));
  wrap.querySelectorAll('.del-batch').forEach(b => b.addEventListener('click', async () => {
    await removeBatchEntry(session.user.id, r.id, b.dataset.date);
    refreshPendingCount();
  }));

  const starPicker = wrap.querySelector('#batch-stars');
  let draftRating = 0;
  const paintStars = () => starPicker.querySelectorAll('span').forEach(s => s.classList.toggle('on', parseInt(s.dataset.v) <= draftRating));
  paintStars();
  starPicker.querySelectorAll('span').forEach(s => s.addEventListener('click', () => { draftRating = parseInt(s.dataset.v); paintStars(); }));

  wrap.querySelector('#add-batch-btn').addEventListener('click', async () => {
    const note = wrap.querySelector('#batch-note').value.trim();
    if (!note && !draftRating) { toast('Add a note or a rating first'); return; }
    try {
      await addBatchEntry(session.user.id, r.id, { date: new Date().toISOString(), note, rating: draftRating });
      toast(state.isOnline ? 'Batch logged' : 'Batch logged — will sync once online');
      refreshPendingCount();
    } catch (e) { console.error(e); toast("Couldn't save that — try again."); }
  });

  return wrap;
}

// Numbered, checkable method. Taps update the DOM in place (no render()),
// so a background sync can't wipe what you've ticked mid-recipe.
function renderMethod(r) {
  const section = el(`<div class="section"><h3>Method</h3></div>`);
  const items = parseSteps(r.instructions);
  const stepTexts = items.filter((it) => it.type === 'step').map((it) => it.text);
  if (!stepTexts.length) { section.appendChild(el(`<div class="prose">${escapeHTML(r.instructions)}</div>`)); return section; }

  const checked = getCheckedSteps(r.id, stepTexts);
  const list = el(`<div class="steps"></div>`);
  let n = 0;
  items.forEach((it) => {
    if (it.type === 'heading') { list.appendChild(el(`<div class="step-heading">${escapeHTML(it.text)}</div>`)); return; }
    const done = checked.has(n);
    list.appendChild(el(`
      <button type="button" class="step ${done ? 'done' : ''}" data-n="${n}" aria-pressed="${done}">
        <span class="step-num">${n + 1}</span>
        <span class="step-text">${escapeHTML(it.text)}</span>
      </button>
    `));
    n++;
  });
  section.appendChild(list);

  const foot = el(`<div class="steps-foot"><span class="steps-count"></span><button type="button" class="link-btn steps-reset">Reset checks</button></div>`);
  const count = foot.querySelector('.steps-count');
  const resetBtn = foot.querySelector('.steps-reset');
  const updateFoot = () => {
    const done = list.querySelectorAll('.step.done').length;
    count.textContent = `${done} of ${stepTexts.length} done`;
    resetBtn.hidden = done === 0;
  };
  updateFoot();
  section.appendChild(foot);

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.step');
    if (!btn) return;
    const i = parseInt(btn.dataset.n, 10);
    const nowDone = !btn.classList.contains('done');
    btn.classList.toggle('done', nowDone);
    btn.setAttribute('aria-pressed', String(nowDone));
    setStepChecked(r.id, i, stepTexts[i], nowDone);
    updateFoot();
  });
  resetBtn.addEventListener('click', () => {
    clearStepChecks(r.id);
    list.querySelectorAll('.step').forEach((b) => { b.classList.remove('done'); b.setAttribute('aria-pressed', 'false'); });
    updateFoot();
  });
  return section;
}

// ---------------- Form ----------------
function renderForm() {
  const f = state.form;
  const isEdit = !!f.id;
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<button class="back" id="back-btn">← Cancel</button>`));
  wrap.appendChild(el(`<h2 style="font-size:1.4rem;margin:8px 0 22px">${isEdit ? 'Edit recipe' : 'New recipe'}</h2>`));

  const form = el(`<form id="recipe-form"></form>`);

  // Import from a link — only when creating, so it can never overwrite a recipe you've already tweaked.
  if (!isEdit) {
    const box = el(`
      <div class="import-box">
        <label for="import-url">Import from a link <span class="optional">(optional)</span></label>
        <div class="import-row">
          <input id="import-url" type="url" inputmode="url" autocomplete="off" placeholder="https://example.com/vanilla-ice-cream">
          <button type="button" id="import-btn">Import</button>
        </div>
        <div class="field-hint" id="import-hint"></div>
        <button type="button" class="link-btn" id="bm-toggle">Site blocked the import? Use the bookmarklet</button>
        <div class="bm-panel" id="bm-panel" hidden>
          <p>Sends the recipe page you're viewing into this form. Set it up once:</p>
          <ol>
            <li><button type="button" class="mini-btn" id="bm-copy">Copy bookmarklet code</button></li>
            <li>Create a new bookmark in your browser, name it "Send to Scoop Journal", and paste the code as its address.</li>
            <li>On any recipe page, click that bookmark.</li>
          </ol>
          <p class="field-hint">Shortcut on a laptop: drag <a class="bm-link" id="bm-link" href="#">Send to Scoop Journal</a> to your bookmarks bar instead.</p>
          <p class="field-hint" id="bm-local" hidden>You're on localhost, so this bookmark would point back to localhost. Open your deployed site to get the real one.</p>
        </div>
      </div>
    `);
    const importInput = box.querySelector('#import-url');
    const importBtn = box.querySelector('#import-btn');
    const importHint = box.querySelector('#import-hint');
    const defaultHint = 'Pulls in the title, ingredients and method. You can edit everything before saving.';
    const setHint = (text, isError) => {
      importHint.textContent = text;
      importHint.classList.toggle('error', !!isError);
    };
    setHint(navigator.onLine ? defaultHint : 'Importing needs an internet connection.');
    importBtn.disabled = !navigator.onLine;

    const runImport = async () => {
      const url = importInput.value.trim();
      if (!url) { setHint('Paste a link first.', true); return; }
      if (!navigator.onLine) { setHint('Importing needs an internet connection.', true); return; }

      const fieldIds = ['#f-title', '#f-ingredients', '#f-instructions'];
      const hasTypedText = fieldIds.some((sel) => form.querySelector(sel).value.trim());
      if (hasTypedText && !confirm("Replace what you've typed so far with the imported recipe?")) return;

      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      setHint('Reading the recipe…');
      try {
        const recipe = await importRecipeFromUrl(url);
        form.querySelector('#f-title').value = recipe.title || '';
        form.querySelector('#f-servings').value = recipe.servings || '';
        form.querySelector('#f-source').value = recipe.source || url;
        form.querySelector('#f-ingredients').value = recipe.ingredients || '';
        form.querySelector('#f-instructions').value = recipe.instructions || '';
        let host = url;
        try { host = new URL(recipe.source || url).hostname.replace(/^www\./, ''); } catch (e) { /* keep url */ }
        setHint(`Imported from ${host}. Check it over and adjust before saving.`);
        toast('Imported. Review and adjust before saving.');
        form.querySelector('#f-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        setHint(err.message, true);
      } finally {
        importBtn.disabled = !navigator.onLine;
        importBtn.textContent = 'Import';
      }
    };
    importBtn.addEventListener('click', runImport);
    importInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runImport(); }
    });
    const bmHref = buildBookmarkletHref(location.origin);
    const bmLink = box.querySelector('#bm-link');
    bmLink.setAttribute('href', bmHref);
    bmLink.addEventListener('click', (e) => {
      e.preventDefault(); // clicking it here would run it on this page; it's meant to be dragged
      toast("Drag this to your bookmarks bar. Don't click it here.");
    });
    box.querySelector('#bm-toggle').addEventListener('click', () => {
      const panel = box.querySelector('#bm-panel');
      panel.hidden = !panel.hidden;
    });
    box.querySelector('#bm-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(bmHref);
        toast('Bookmarklet code copied.');
      } catch (e) {
        toast("Couldn't copy. Try dragging the button on a laptop instead.");
      }
    });
    if (['localhost', '127.0.0.1'].includes(location.hostname)) box.querySelector('#bm-local').hidden = false;
    form.appendChild(box);
  }

  form.appendChild(el(`<div class="field"><label>Title</label><input id="f-title" required value="${escapeAttr(f.title)}" placeholder="Brown butter pecan"></div>`));

  const twoCol = el(`<div class="two-col"></div>`);
  const catField = el(`<div class="field"><label>Category</label></div>`);
  const select = el(`<select id="f-category"></select>`);
  CATEGORIES.forEach(c => select.appendChild(el(`<option value="${escapeAttr(c)}" ${f.category === c ? 'selected' : ''}>${escapeHTML(c)}</option>`)));
  catField.appendChild(select);
  twoCol.appendChild(catField);
  twoCol.appendChild(el(`<div class="field"><label>Makes</label><input id="f-servings" value="${escapeAttr(f.servings || '')}" placeholder="1 quart"></div>`));
  form.appendChild(twoCol);

  form.appendChild(el(`<div class="field"><label>Source (optional)</label><input id="f-source" value="${escapeAttr(f.source || '')}" placeholder="Salt & Straw cookbook, adapted"></div>`));
  form.appendChild(el(`<div class="field"><label>Ingredients</label><textarea id="f-ingredients" placeholder="2 cups heavy cream&#10;1 cup whole milk&#10;3/4 cup sugar">${escapeHTML(f.ingredients || '')}</textarea><div class="field-hint">One per line, however you like to write them.</div></div>`));
  form.appendChild(el(`<div class="field"><label>Method</label><textarea id="f-instructions" placeholder="Heat cream and milk...">${escapeHTML(f.instructions || '')}</textarea><div class="field-hint">One step per line. Numbers are added for you, so no need to type them.</div></div>`));
  form.appendChild(el(`<div class="field"><label>My tweaks & adjustments</label><textarea id="f-tweaks" placeholder="Cut sugar to 1/2 cup, added a splash of bourbon...">${escapeHTML(f.tweaks || '')}</textarea></div>`));
  form.appendChild(el(`<div class="field"><label>Tags</label><input id="f-tags" value="${escapeAttr(f.tags || '')}" placeholder="summer, nuts, boozy"><div class="field-hint">Comma separated.</div></div>`));

  const ratingField = el(`<div class="field"><label>Overall rating</label></div>`);
  const starSelect = el(`<div class="star-select">${[1,2,3,4,5].map(i => `<span data-v="${i}">★</span>`).join('')}</div>`);
  ratingField.appendChild(starSelect);
  form.appendChild(ratingField);
  let formRating = f.rating || 0;
  const paintFormStars = () => starSelect.querySelectorAll('span').forEach(s => s.classList.toggle('on', parseInt(s.dataset.v) <= formRating));
  paintFormStars();
  starSelect.querySelectorAll('span').forEach(s => s.addEventListener('click', () => {
    const v = parseInt(s.dataset.v);
    formRating = (formRating === v) ? v - 1 : v;
    paintFormStars();
  }));

  const photoField = el(`<div class="field"><label>Photos</label></div>`);
  const photoGrid = el(`<div class="photo-grid"></div>`);
  function renderPhotoGrid() {
    photoGrid.innerHTML = '';
    state.pendingPhotos.forEach((p, i) => {
      const w = el(`<div class="photo-thumb-wrap"></div>`);
      w.appendChild(el(`<img class="photo-thumb" src="${p.url}">`));
      const rm = el(`<button type="button" class="photo-remove">×</button>`);
      rm.addEventListener('click', () => { state.pendingPhotos.splice(i, 1); renderPhotoGrid(); });
      w.appendChild(rm);
      photoGrid.appendChild(w);
    });
    const addBtn = el(`<button type="button" class="photo-add">+</button>`);
    addBtn.addEventListener('click', () => {
      if (!navigator.onLine) { toast("Photos need an internet connection — add this one once you're back online."); return; }
      fileInput.click();
    });
    photoGrid.appendChild(addBtn);
  }
  const fileInput = el(`<input type="file" accept="image/*" multiple style="display:none">`);
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    fileInput.value = '';
    for (const file of files) {
      const previewUrl = URL.createObjectURL(file);
      const tempEntry = { path: null, url: previewUrl };
      state.pendingPhotos.push(tempEntry);
      renderPhotoGrid();
      const resized = await resizeImage(file, 1600);
      try {
        const result = await uploadPhoto(session.user.id, resized || file);
        tempEntry.path = result.path;
        tempEntry.url = result.url;
      } catch (err) {
        console.error(err);
        toast("That photo didn't upload — try again.");
        state.pendingPhotos = state.pendingPhotos.filter(p => p !== tempEntry);
      }
      renderPhotoGrid();
    }
  });
  renderPhotoGrid();
  photoField.appendChild(photoGrid);
  photoField.appendChild(fileInput);
  form.appendChild(photoField);

  const actions = el(`<div class="form-actions"></div>`);
  const saveBtn = el(`<button type="submit" class="primary-btn">${isEdit ? 'Save changes' : 'Add recipe'}</button>`);
  actions.appendChild(saveBtn);
  form.appendChild(actions);

  if (isEdit) {
    const delBtn = el(`<button type="button" class="delete-link">Delete this recipe</button>`);
    delBtn.addEventListener('click', async () => {
      if (confirm("Delete this recipe and its batch notes? This can't be undone.")) {
        await deleteRecipe(session.user.id, f.id);
        refreshPendingCount();
        goList();
      }
    });
    form.appendChild(delBtn);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const data = {
      title: form.querySelector('#f-title').value.trim() || 'Untitled',
      category: form.querySelector('#f-category').value,
      servings: form.querySelector('#f-servings').value.trim(),
      source: form.querySelector('#f-source').value.trim(),
      ingredients: form.querySelector('#f-ingredients').value,
      instructions: form.querySelector('#f-instructions').value,
      tweaks: form.querySelector('#f-tweaks').value,
      tags: form.querySelector('#f-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      rating: formRating,
      photo_paths: state.pendingPhotos.filter(p => p.path).map(p => p.path),
    };
    try {
      const id = await saveRecipe(session.user.id, data, f.id || null);
      toast(state.isOnline ? (isEdit ? 'Recipe updated' : 'Recipe added') : 'Saved on this device — will sync once online');
      refreshPendingCount();
      goDetail(id);
    } catch (err) {
      console.error(err);
      toast("Couldn't save — try again.");
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save changes' : 'Add recipe';
    }
  });

  wrap.querySelector('#back-btn').addEventListener('click', () => { if (isEdit) goDetail(f.id); else goList(); });
  wrap.appendChild(form);
  return wrap;
}

function resizeImage(file, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
    };
    img.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

// Logout wired from the header once logged in — added here so it's easy to find.
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'logout-btn') signOut();
});

captureImportFromHash();
boot();
