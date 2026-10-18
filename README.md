# Mwilu Agro Estate – online deployment

```
web/      the existing app (index.html, unchanged except 2 one-line edits) + sync.js + config.js   -> GitHub Pages
server/   Node/Express API + schema.sql + import-backup.js                                         -> Render/Railway/Fly
database  hosted PostgreSQL (Neon / Supabase / Render Postgres)
```

## What was wrong
The uploaded file is a single static HTML page. It stores everything in the browser (`localStorage`, key
`mwilu_goat_sharing_v1`, plus IndexedDB `mwilu_files`), has no backend, no database, no service worker, and **does not
contain the text "Offline – changes will be saved when the connection returns."** That banner is therefore produced by
whatever is *hosting/previewing* the page, not by this code. Whatever the reason for the banner, this app could never
share data between users, because each browser only ever saw its own copy. That is fixed by this change.

## Changes to existing code (everything else is byte-for-byte unchanged)
1. `function save(){…}` – no longer writes to localStorage.
2. `const savedOk=…` – checks in-memory data (it used to read localStorage).
3. Two `<script>` tags appended at the end: `config.js`, `sync.js`. `sync.js` replaces `save`, `login`, `gSync`, adds the
   status pill, polling, retry, conflict handling. Original local data in the browser is **left untouched**.

## Environment variables (BACKEND host only – never in GitHub, never in the frontend)
| Name | Value |
|---|---|
| `DATABASE_URL` | connection string from your Postgres provider |
| `JWT_SECRET` | 48+ random chars: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `FRONTEND_ORIGIN` | `https://<github-username>.github.io` (exact origin, no path, no trailing slash) |

GitHub: *Settings → Secrets and variables → Actions → Variables* → `MWILU_API_URL` = your backend URL (public, not secret).

## Publish – step by step
1. **Back up first.** In the OLD app, log in as owner → *Download JSON backup*. Keep this file safe (do not commit it).
2. Create a Postgres database (e.g. Neon free tier). Copy its connection string.
3. Run the schema + import from your computer (Node 18+):
   ```
   cd server && npm install
   DATABASE_URL="<string>" node import-backup.js path/to/mwilu-backup-YYYY-MM-DD.json
   ```
   It refuses to overwrite a non-empty database, hashes every PIN, and prints record counts per list. **Compare them with your old app.**
4. Deploy `server/` to Render (Web Service, root dir `server`, build `npm install`, start `npm start`), add the 3 variables.
   Open `https://<your-api>/api/health` → `{"ok":true}`.
5. Push this repo to GitHub. Settings → Pages → Source: *GitHub Actions*. Add the `MWILU_API_URL` variable. Push to `main`.
6. Open the site, log in with an existing username/PIN. The pill (bottom-left) must show **✓ Saved to server**.
7. **Change every default `1234` PIN immediately** (they are in your old code and therefore public).
8. Test with two devices: add a record on one, see it on the other within ~20 s.

## Backup / recovery
Provider daily backups + `collection_history` (every write of every list is kept). Restore a list:
`UPDATE collections SET data=(SELECT data FROM collection_history WHERE key='goats' AND version=N), version=version+1 WHERE key='goats';`

## Known limitations – read before go-live
* **PDF/ID uploads** (IndexedDB `mwilu_files`) are still browser-local. They need server file storage (e.g. Supabase Storage, private bucket). Not done.
* **Permission matrix** in `server/server.js` (`WRITE`, `ANON_*`) is my best reading of the roles; I did not audit every module. Review it.
* **Applicant self-registration** (public creates a login) is blocked by the server by design; it needs a dedicated `/api/register` endpoint.
* Reference numbers (`ORD-…`) are still generated in the browser; the server rejects a clash (409) but does not renumber.
* Conflicts are per list: the later editor is told to reload and redo (nothing is silently overwritten).
* Offline edits are held in the open page only (no business data is cached on the device); a prompt appears if you try to close with unsaved changes.
* The app's own toasts saying "Saved" are shown as "Saving to server…"; only the pill's ✓ means the database confirmed.
