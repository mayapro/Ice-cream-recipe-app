import { supabase } from './supabase-client.js';
import {
  getAllRecipesLocal, putRecipeLocal, deleteRecipeLocal, rekeyRecipeLocal,
  replaceServerRecipesLocal, addOutboxEntry, getAllOutboxEntries, deleteOutboxEntry, outboxCount,
} from './idb.js';

let syncing = false;

function isTempId(id) { return typeof id === 'string' && id.startsWith('local-'); }
function newTempId() { return 'local-' + crypto.randomUUID(); }

// ==================== Raw server calls ====================
// These talk directly to Supabase. Used both for the "try it immediately
// while online" path and by the sync engine replaying queued changes.

async function insertRecipeServer(userId, fields) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('recipes')
    .insert({ ...fields, owner_id: userId, batches: [], created_at: now, updated_at: now })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateRecipeServer(userId, id, fields) {
  const { error } = await supabase
    .from('recipes')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('owner_id', userId);
  if (error) throw error;
}

async function deleteRecipeServer(userId, id) {
  const { error } = await supabase.from('recipes').delete().eq('id', id).eq('owner_id', userId);
  if (error) throw error;
}

async function appendBatchServer(userId, id, entry) {
  const { data: row, error: selErr } = await supabase.from('recipes').select('batches').eq('id', id).single();
  if (selErr) throw selErr;
  const batches = [...(row.batches || []), entry];
  const { error } = await supabase.from('recipes').update({ batches, updated_at: new Date().toISOString() }).eq('id', id).eq('owner_id', userId);
  if (error) throw error;
}

async function removeBatchServer(userId, id, entryDate) {
  const { data: row, error: selErr } = await supabase.from('recipes').select('batches').eq('id', id).single();
  if (selErr) throw selErr;
  const batches = (row.batches || []).filter((b) => b.date !== entryDate);
  const { error } = await supabase.from('recipes').update({ batches }).eq('id', id).eq('owner_id', userId);
  if (error) throw error;
}

async function fetchRecipesServer(userId) {
  const { data, error } = await supabase.from('recipes').select('*').eq('owner_id', userId).order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ==================== Local-first API (what app.js uses) ====================

// Loads the local cache instantly, then reconciles with the server in the
// background (and stays in sync via realtime). onChange fires every time
// the recipe list changes, from either source.
export function subscribeToRecipes(userId, onChange) {
  let stopped = false;
  let channel = null;

  (async () => {
    const local = await getAllRecipesLocal();
    if (!stopped) onChange(sortByUpdated(local.filter((r) => r.owner_id === userId)));
  })();

  async function refreshFromServer() {
    try {
      const rows = await fetchRecipesServer(userId);
      await replaceServerRecipesLocal(rows);
      if (!stopped) {
        const local = await getAllRecipesLocal();
        onChange(sortByUpdated(local.filter((r) => r.owner_id === userId)));
      }
    } catch (e) {
      console.warn('Could not reach the server — showing local data.', e);
    }
  }

  refreshFromServer();
  syncOutbox(userId).then(refreshFromServer);

  if (navigator.onLine) {
    channel = supabase
      .channel('recipes-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recipes', filter: `owner_id=eq.${userId}` }, refreshFromServer)
      .subscribe();
  }

  const onOnline = () => syncOutbox(userId).then(refreshFromServer);
  window.addEventListener('online', onOnline);

  return () => {
    stopped = true;
    window.removeEventListener('online', onOnline);
    if (channel) supabase.removeChannel(channel);
  };
}

function sortByUpdated(rows) {
  return [...rows].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export async function getPendingSyncCount() {
  return outboxCount();
}

export async function saveRecipe(userId, fields, id) {
  const now = new Date().toISOString();

  if (!id) {
    // Create. Always go local-first with a temp id, then try the network.
    const tempId = newTempId();
    const localRow = { id: tempId, owner_id: userId, ...fields, batches: [], created_at: now, updated_at: now };
    await putRecipeLocal(localRow);

    if (navigator.onLine) {
      try {
        const serverRow = await insertRecipeServer(userId, fields);
        await rekeyRecipeLocal(tempId, serverRow);
        return serverRow.id;
      } catch (e) {
        console.warn('Create failed online, queuing for later sync.', e);
      }
    }
    await addOutboxEntry({ type: 'upsert', isCreate: true, id: tempId, fields });
    return tempId;
  }

  // Update.
  const existing = (await getAllRecipesLocal()).find((r) => r.id === id);
  const localRow = { ...(existing || {}), ...fields, id, owner_id: userId, updated_at: now };
  await putRecipeLocal(localRow);

  if (isTempId(id)) {
    // Not yet created on the server — fold this edit into the outbox; the
    // sync engine will apply it right after the queued create, in order.
    await addOutboxEntry({ type: 'upsert', isCreate: false, id, fields });
    return id;
  }

  if (navigator.onLine) {
    try {
      await updateRecipeServer(userId, id, fields);
      return id;
    } catch (e) {
      console.warn('Update failed online, queuing for later sync.', e);
    }
  }
  await addOutboxEntry({ type: 'upsert', isCreate: false, id, fields });
  return id;
}

export async function deleteRecipe(userId, id) {
  await deleteRecipeLocal(id);

  if (isTempId(id)) {
    // Never made it to the server — just drop any queued work for it.
    const entries = await getAllOutboxEntries();
    for (const e of entries) {
      if (e.id === id) await deleteOutboxEntry(e.seq);
    }
    return;
  }

  if (navigator.onLine) {
    try {
      await deleteRecipeServer(userId, id);
      return;
    } catch (e) {
      console.warn('Delete failed online, queuing for later sync.', e);
    }
  }
  await addOutboxEntry({ type: 'delete', id });
}

export async function addBatchEntry(userId, recipeId, entry) {
  const existing = (await getAllRecipesLocal()).find((r) => r.id === recipeId);
  if (existing) {
    const batches = [...(existing.batches || []), entry];
    await putRecipeLocal({ ...existing, batches, updated_at: new Date().toISOString() });
  }

  if (!isTempId(recipeId) && navigator.onLine) {
    try {
      await appendBatchServer(userId, recipeId, entry);
      return;
    } catch (e) {
      console.warn('Batch log failed online, queuing for later sync.', e);
    }
  }
  await addOutboxEntry({ type: 'addBatch', id: recipeId, entry });
}

export async function removeBatchEntry(userId, recipeId, entryDate) {
  const existing = (await getAllRecipesLocal()).find((r) => r.id === recipeId);
  if (existing) {
    const batches = (existing.batches || []).filter((b) => b.date !== entryDate);
    await putRecipeLocal({ ...existing, batches });
  }

  if (!isTempId(recipeId) && navigator.onLine) {
    try {
      await removeBatchServer(userId, recipeId, entryDate);
      return;
    } catch (e) {
      console.warn('Batch removal failed online, queuing for later sync.', e);
    }
  }
  await addOutboxEntry({ type: 'removeBatch', id: recipeId, entryDate });
}

// Photos still need a live connection to upload to Supabase Storage —
// callers should check navigator.onLine before offering the photo picker.
export async function uploadPhoto(userId, blob) {
  const path = `${userId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from('photos').getPublicUrl(path);
  return { path, url: data.publicUrl };
}

// ==================== Sync engine ====================
// Replays queued offline changes against the server, in the order they
// happened. Stops at the first failure so nothing gets applied out of
// order; whatever's left just stays queued and retries next time.
export async function syncOutbox(userId) {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const entries = await getAllOutboxEntries();
    const idMap = {};
    for (const entry of entries) {
      const resolvedId = idMap[entry.id] || entry.id;
      try {
        if (entry.type === 'upsert' && entry.isCreate) {
          const serverRow = await insertRecipeServer(userId, entry.fields);
          idMap[entry.id] = serverRow.id;
          await rekeyRecipeLocal(entry.id, serverRow);
        } else if (entry.type === 'upsert' && !entry.isCreate) {
          await updateRecipeServer(userId, resolvedId, entry.fields);
        } else if (entry.type === 'delete') {
          await deleteRecipeServer(userId, resolvedId);
        } else if (entry.type === 'addBatch') {
          await appendBatchServer(userId, resolvedId, entry.entry);
        } else if (entry.type === 'removeBatch') {
          await removeBatchServer(userId, resolvedId, entry.entryDate);
        }
        await deleteOutboxEntry(entry.seq);
      } catch (e) {
        console.error('Sync stopped on entry', entry, e);
        break; // leave this and everything after it queued; retry later
      }
    }
  } finally {
    syncing = false;
  }
}
