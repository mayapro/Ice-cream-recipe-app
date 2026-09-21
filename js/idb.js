const DB_NAME = 'scoop-journal';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recipes')) {
        db.createObjectStore('recipes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------------- Recipes cache ----------------
export async function getAllRecipesLocal() {
  const db = await openDB();
  const store = db.transaction('recipes', 'readonly').objectStore('recipes');
  return reqP(store.getAll());
}

export async function putRecipeLocal(recipe) {
  const db = await openDB();
  const t = db.transaction('recipes', 'readwrite');
  t.objectStore('recipes').put(recipe);
  await txDone(t);
}

export async function deleteRecipeLocal(id) {
  const db = await openDB();
  const t = db.transaction('recipes', 'readwrite');
  t.objectStore('recipes').delete(id);
  await txDone(t);
}

// Rekey a locally-created recipe once the server assigns it a real id.
export async function rekeyRecipeLocal(oldId, newRecipe) {
  const db = await openDB();
  const t = db.transaction('recipes', 'readwrite');
  const store = t.objectStore('recipes');
  store.delete(oldId);
  store.put(newRecipe);
  await txDone(t);
}

// Replace the whole local cache with a fresh set from the server. Any rows
// that only exist locally because they're still pending sync (temp ids) are
// preserved rather than wiped out by this refresh.
export async function replaceServerRecipesLocal(serverRecipes) {
  const db = await openDB();
  const t = db.transaction('recipes', 'readwrite');
  const store = t.objectStore('recipes');
  const existing = await reqP(store.getAll());
  const pendingOnly = existing.filter((r) => String(r.id).startsWith('local-'));
  store.clear();
  serverRecipes.forEach((r) => store.put(r));
  pendingOnly.forEach((r) => store.put(r));
  await txDone(t);
}

// ---------------- Outbox (queued offline changes) ----------------
export async function addOutboxEntry(entry) {
  const db = await openDB();
  const t = db.transaction('outbox', 'readwrite');
  t.objectStore('outbox').add(entry);
  await txDone(t);
}

export async function getAllOutboxEntries() {
  const db = await openDB();
  const store = db.transaction('outbox', 'readonly').objectStore('outbox');
  const entries = await reqP(store.getAll());
  return entries.sort((a, b) => a.seq - b.seq);
}

export async function deleteOutboxEntry(seq) {
  const db = await openDB();
  const t = db.transaction('outbox', 'readwrite');
  t.objectStore('outbox').delete(seq);
  await txDone(t);
}

export async function outboxCount() {
  const entries = await getAllOutboxEntries();
  return entries.length;
}
