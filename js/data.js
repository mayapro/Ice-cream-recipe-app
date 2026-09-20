import { supabase } from './supabase-client.js';

export function subscribeToRecipes(userId, onChange) {
  // Initial fetch, then a realtime channel keeps every open device in sync.
  fetchRecipes(userId).then(onChange);

  const channel = supabase
    .channel('recipes-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipes', filter: `owner_id=eq.${userId}` },
      () => fetchRecipes(userId).then(onChange)
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

export async function fetchRecipes(userId) {
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function saveRecipe(userId, fields, id) {
  const now = new Date().toISOString();
  if (id) {
    const { error } = await supabase
      .from('recipes')
      .update({ ...fields, updated_at: now })
      .eq('id', id)
      .eq('owner_id', userId);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase
    .from('recipes')
    .insert({ ...fields, owner_id: userId, batches: [] })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function deleteRecipe(userId, id) {
  const { error } = await supabase.from('recipes').delete().eq('id', id).eq('owner_id', userId);
  if (error) throw error;
}

export async function addBatchEntry(userId, recipe, entry) {
  const batches = [...(recipe.batches || []), entry];
  const { error } = await supabase
    .from('recipes')
    .update({ batches, updated_at: new Date().toISOString() })
    .eq('id', recipe.id)
    .eq('owner_id', userId);
  if (error) throw error;
}

export async function removeBatchEntry(userId, recipe, index) {
  const batches = (recipe.batches || []).filter((_, i) => i !== index);
  const { error } = await supabase
    .from('recipes')
    .update({ batches })
    .eq('id', recipe.id)
    .eq('owner_id', userId);
  if (error) throw error;
}

export async function uploadPhoto(userId, blob) {
  const path = `${userId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from('photos').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from('photos').getPublicUrl(path);
  return { path, url: data.publicUrl };
}

export async function deletePhoto(path) {
  await supabase.storage.from('photos').remove([path]);
}
