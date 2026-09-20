// Fill these in from Supabase Dashboard → Project Settings → API.
// SUPABASE_ANON_KEY is safe to ship in client code — it's the public key,
// meant to be used from the browser. Access control lives in the RLS
// policies in schema.sql, not in keeping this key secret.
export const SUPABASE_URL = 'https://aawqzehzyjmaqkudrfgl.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhd3F6ZWh6eWptYXFrdWRyZmdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3OTQwMzUsImV4cCI6MjEwNTM3MDAzNX0.OojUAYmI7LxX7cl-FUjps5dbX_g-UUnQZdrz58UHyRE';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
