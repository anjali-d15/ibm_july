# Ledger

A writing app where every AI-assisted alternative becomes a node in a navigable decision tree.

## Quick start

### 1. Environment

Copy `.env` and fill in your watsonx credentials when needed for P2+:

```sh
# .env is already present — edit if needed
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

### 2. Backend

```sh
cd server
npm install
npm run dev        # node --watch, auto-restarts on file changes
```

Server starts at `http://localhost:3001`. SQLite DB is created at `server/ledger.db` on first run and seeded with a hardcoded document (`doc_hardcoded_001`).

### 3. Frontend

```sh
cd client
npm install
npm run dev        # Vite dev server at http://localhost:5173
```

Open `http://localhost:5173`. The editor loads the seeded document and autosaves every ~500 ms.

## API (P1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/document/:id` | Raw document row |
| GET | `/document/:id/resolved` | Segment array of resolved document |
| PATCH | `/document/:id/content` | Autosave `root_content` (P1 only) |

### Segment array shape

```json
{
  "segments": [
    { "text": "...", "fork_id": null, "start": 0, "end": 566 }
  ]
}
```

For P1 (no forks), always one segment with `fork_id: null`.

## Project structure

```
server/
  src/
    db.js        — SQLite init, schema, seed
    resolve.js   — segment-array resolution (recursive descent)
    index.js     — Express app + routes
client/
  src/
    main.jsx     — React entry
    App.jsx      — loads resolved document on mount
    Editor.jsx   — Tiptap editor + 500ms autosave debounce
    Editor.css   — editor styles
implementation-plan.md  — full spec + phase plan
```

## Phases

| Phase | Status |
|---|---|
| P1 — Schema, seed, live editor, `/resolved` segment array | ✅ |
| P2 — Alternative generation, Granite, locking | ⬜ |
| P3 — Approve, reject, cancel, force-unlock, `PATCH /edit` | ⬜ |
| P4 — Tree/map view, switch-branch | ⬜ |
| P5 — Drift detection (stretch) | ⬜ |
