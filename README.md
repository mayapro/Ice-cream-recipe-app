# Scoop Journal

Your own ice cream recipe journal. Plain HTML/CSS/JS (no build step, no framework), backed by Supabase (Postgres + Auth + Storage). Installable as a PWA on your phone.

## 1. Configure Supabase

1. Create a project at supabase.com (if you haven't already).
2. Open **SQL Editor** → paste in `schema.sql` → run it. This creates the `recipes` table, its row-level-security policies, and the `photos` storage bucket.
3. Go to **Project Settings → API** and copy:
   - Project URL
   - `anon` public key
4. Open `js/supabase-client.js` and paste both into `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
5. Go to **Authentication → URL Configuration** and set **Site URL** to wherever you're running the app (`http://localhost:3000` while developing, your real domain once deployed). This is what the magic-link email redirects back to.

## 2. Run it locally

The app uses ES module imports (`import`/`export`), so you can't just double-click `index.html` — browsers block module loading over `file://`. Serve it instead:

- **VS Code**: install the "Live Server" extension, right-click `index.html` → "Open with Live Server".
- **or, from the terminal**: `npx serve .` from inside the project folder, then open the URL it prints.

Open it, enter your email, and check your inbox for the magic link.

## 3. Deploy it for real

Push this folder to your git repo, then connect it to Vercel, Netlify, or Cloudflare Pages (all have a free tier and auto-deploy on push — no build command needed, it's static files). Once deployed:

- Update the Supabase **Site URL** to your real domain.
- Visit the site on your phone and use "Add to Home Screen" (Safari: Share → Add to Home Screen; Android Chrome: ⋮ menu → Add to Home Screen) to install it as an app icon.

## Project structure

```
index.html          — app shell, loads fonts/CSS/JS, registers the service worker
manifest.json        — PWA metadata (name, icons, colors)
sw.js                — service worker; caches the app shell for offline launch
css/style.css         — all styling
js/supabase-client.js — fill in your Supabase URL + anon key here
js/auth.js            — magic-link sign in / sign out
js/data.js            — recipe CRUD, photo upload, realtime sync
js/app.js             — UI: rendering, view state, event handling
icons/                — app icons (swap these for your own artwork anytime)
schema.sql            — paste into Supabase's SQL editor once
```

## Notes on the data model

- Each recipe is one row in `recipes`. Batch notes (your dated "how did it turn out" log) live as a JSON array in the `batches` column on that same row — no separate table.
- Photos live in Supabase Storage under `photos/<your-user-id>/<random-name>.jpg`. Only you can upload/delete into your own folder (enforced by storage policies in `schema.sql`); the bucket is public-read, so the returned URLs work directly in `<img>` tags without extra signing. Paths are random and unguessable, but if you want them fully private later, flip the bucket to private and switch `getPublicUrl` to `createSignedUrl` in `js/data.js`.
- Realtime sync: `js/data.js` subscribes to Postgres changes on your rows, so edits on one device show up on another without a refresh.

## Offline support

The app is local-first: every recipe is mirrored into the browser's IndexedDB (`js/idb.js`), and every change you make — add, edit, delete, batch notes — writes to that local copy immediately and queues in an "outbox." When you're back online, the outbox replays against Supabase in the order things happened (`syncOutbox` in `js/data.js`), then everything reconciles via a fresh fetch and realtime subscription.

What this means in practice:
- You can view, add, and edit recipes with zero connection. A banner at the top says so, and shows how many changes are waiting to sync once you're back.
- **Photos are the one exception** — uploading a new photo still needs a live connection (Supabase Storage has no offline queue here), so the "+" button just asks you to wait until you're online.
- If you edit the *same* recipe on two devices while both are offline, the sync engine doesn't merge — whichever change syncs second silently overwrites the first (last-write-wins). Fine for how one person uses this day to day; worth knowing if that ever happens.

## What's not built yet (ideas for later)

- Offline photo queueing (store the blob locally, upload once back online).
- Numbered-step instructions instead of one paragraph (small frontend-only change, discussed separately).
- Per-step photos/timers (would need a schema change — a proper JSON/array column instead of plain text).
