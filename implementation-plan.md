# Ledger — Implementation Plan

## Overview

Ledger is a writing app where a creator writes directly in a live text editor. 
Instead of silently overwriting their own work when trying alternatives, every 
"try something different" moment becomes a tracked, reversible decision in a 
navigable tree.

Core interaction: select a passage, request an AI-generated alternative, 
approve or reject it, and later surf between any past decision and the paths 
not taken — never losing anything, never auto-editing anything without approval.

## Core Concept

The document is not a static, mutable string. It is the result of walking a 
tree of decisions from an original root, applying whichever branch is "active" 
at each fork point. Rejected alternatives are never deleted — they stay in the 
tree, viewable and re-selectable at any time. Switching which fork is active 
at any point recomputes what the document looks like.

## Data Model

### Document
| Field | Type | Notes |
|---|---|---|
| id | string | primary key |
| title | string | |
| root_content | text | the original, untouched content |
| created_at | timestamp | |

### Fork
| Field | Type | Notes |
|---|---|---|
| id | string | primary key |
| document_id | string | foreign key |
| parent_fork_id | string, nullable | null if attached directly to root; offsets are relative to the parent's resolved output, not to root_content globally |
| anchor_start | integer | plain-text character offset within the **parent's resolved content** — derived from Tiptap's `doc.textBetween()`, NOT raw ProseMirror positions |
| anchor_end | integer | see above |
| original_snippet | text | frozen snapshot of what was there |
| branch_content | text | AI-generated alternative; mutated in-place by direct edits (not replaced with a new fork row) |
| why | text, nullable | AI-drafted summary, editable/confirmable by user; nullable — a fork with why=null is valid and normal |
| status | enum | `proposed` \| `resolved` \| `failed` |
| is_active | boolean | true if this branch is currently live in the document |
| created_at | timestamp | |
| updated_at | timestamp | for debugging stuck locks only — no business logic |

### Database-level constraints
- Partial unique index: at most one `Fork` per `document_id` WHERE `status='proposed'`
- Partial unique index: at most one `Fork` per `(document_id, anchor point)` WHERE `is_active=true`
- Hard cap on `branch_content` / `why` length (prevents unbounded AI output from corrupting resolution or blowing up later drift-detection prompts)

### Single hardcoded document
The app operates on one document, seeded at DB startup with sample text using
an upsert (`INSERT ... ON CONFLICT DO UPDATE`) that only overwrites `root_content`
when it is empty, so real user edits survive restarts. No `POST /document`
endpoint, no document list, no routing.

## Tree Resolution — Server-Side Only

The frontend never computes tree logic.

**`GET /document/:id/resolved`**

Returns a **segment array** — not a flat string. Each segment:
```
{ text: string, fork_id: string | null, start: number, end: number }
```
where `start`/`end` are offsets within the concatenated resolved document.
The frontend joins segments to produce the display string and uses segment
tags to determine `parent_fork_id` and compute offsets on selection.

Resolution algorithm: **recursive descent down the active path.** At each
level, apply the active fork's `branch_content` at `[anchor_start, anchor_end]`
relative to *that level's already-resolved text*, then recurse into children.
Offsets are never relative to `root_content` globally — each level's offsets
are in its own coordinate space. If a parent fork is `is_active=false`, its
entire subtree is skipped. The walk treats `failed` and rejected
(`status=resolved, is_active=false`) forks identically — both are skipped.

The frontend calls this after every mutation (approve, reject, switch-branch,
direct edit) and simply re-renders — it does not resolve the tree itself.

**`GET /document/:id/tree`**
Returns the flat list of all `Fork` rows for this document (with
`parent_fork_id`, `is_active`, `status`, `original_snippet`, `branch_content`,
`why`) so the frontend can build the visual map. Frontend computes depth and
layout from `parent_fork_id` + `is_active` client-side — no server-side layout
computation.

## Editing Rules

Once any fork exists on a document, free-form typing is blocked **except**:

1. **Append at end:** typing new content after the last segment is always
   allowed — no existing `anchor_start`/`anchor_end` is affected. Detected
   client-side by checking cursor position ≥ `end` of the final segment in
   the `/resolved` segment array. Writes to the entity owning the last segment
   (`root_content` if last segment is root, or the owning fork's `branch_content`).

2. **In-segment direct edit:** a "edit directly" action (no Granite call)
   replaces a selection within a single segment. Mutates the owning entity's
   content in-place (`root_content` or `branch_content`). After persisting,
   shifts `anchor_start`/`anchor_end` only for forks whose `parent_fork_id`
   matches the edited segment's `fork_id` (or `null` for root) — never forks
   in sibling branches or unrelated subtrees, as their offsets live in a
   different coordinate space.

**Cross-segment selections are rejected hard** — frontend disables/warns if
a selection crosses a segment boundary; backend validates and returns an error.

Both operations go through `PATCH /document/:id/edit`:
```
Body: { segment_fork_id: string | null, anchor_start: number, anchor_end: number, replacement: string }
```
Append is a zero-length selection (`anchor_start === anchor_end`) at the end
of the last segment. Same document lock rule applies — no pending fork allowed.

## Autosave & Debounce

All edits (direct edits, appends) are debounced ~500ms using P1's autosave
mechanism (or a fresh ~500ms debounce if P1's can't be extended cleanly).

**Critical invariant:** flush the debounce buffer synchronously and await the
`PATCH` success response before beginning any fork operation (generate
alternative, approve, reject, switch-branch). Fork operations must never begin
against stale persisted content, as offset calculations depend on it.

## Locking Behavior

Only one fork can be pending (`status=proposed`) at a time per document.
While a fork is pending, the entire document is locked — no editing anywhere
until it's resolved (approved, rejected, or failed). This avoids offset drift
in `anchor_start`/`anchor_end` and avoids handling overlapping pending forks,
which is out of scope for this build.

## Core Flow

1. Writer types directly into the editor. When no forks exist, this edits
   `root_content` via autosave. When forks exist, only append-at-end and
   in-segment direct edits are permitted (see Editing Rules above).
2. Writer selects a range of text within a single segment, clicks
   "show alternative." Frontend flushes any pending debounced save and awaits
   success before proceeding.
3. Frontend immediately disables the "generate alternative" action
   (optimistic UI lock) to prevent double-submission before the backend
   responds.
4. Frontend presents an optional instruction step: a free-form text input
   ("make this colder," "have her forgive him") and four preset chips —
   **Warmer**, **Colder**, **More concise**, **Surprise me**. Selecting a
   preset populates the text input; the user may also type freely or leave it
   blank entirely. Frontend then sends:
   ```
   { segment_fork_id, anchor_start, anchor_end, selected_text, instruction?: string }
   ```
   `instruction` is omitted (or `""`) when the user leaves the field blank.
   `segment_fork_id` is read from the segment tag in the `/resolved` array —
   the frontend does not re-derive it. Backend validates that the selection
   falls within a single segment.
5. Backend attempts to `INSERT` a new `Fork` row (`status=proposed`,
   `is_active=false`) as a single atomic operation relying on the partial
   unique index to reject a second concurrent pending fork — never a
   "check then insert" pattern, to avoid a race window. If the insert is
   rejected, return a clean "a fork is already pending" error.
6. Backend calls IBM Granite (via watsonx). The prompt incorporates
   `instruction` when present:
   - **With instruction:** *"Rewrite the following passage so that it [instruction].
     Return ONLY the rewritten text as JSON: `{"alternative": "..."}`."*
   - **Without instruction (blank or omitted):** *"Write an alternative version
     of the following passage that preserves its general tone and intent.
     Return ONLY the rewritten text as JSON: `{"alternative": "..."}`."*

   Granite must return structured output only — no preamble, no multiple
   options, no markdown. Backend parses defensively: if the response isn't
   valid JSON or the `alternative` field is missing/empty, the fork transitions
   to `status=failed` rather than storing garbled content. `instruction` is
   used only to shape this call; it is not stored on the Fork row.
7. Document locks entirely. Frontend shows `original_snippet` vs.
   `branch_content` side-by-side for review.
8. Writer approves or rejects:
   - **Approve:** In a single transaction: `is_active=true` on this fork,
     `is_active=false` on any sibling forks at the same anchor point,
     `status=resolved`. Document unlocks immediately. Frontend re-fetches
     `/resolved` and re-renders. `why` generation is triggered asynchronously
     as a non-blocking background call (see Why Field below) — it does not
     hold the lock.
   - **Reject:** `status=resolved`, `is_active` stays `false`. Fork remains
     stored and viewable in the tree. Document unlocks, unchanged.
9. **Tree/map view:** renders all forks as a navigable tree using
   `/document/:id/tree` data. Clicking a node shows its `original_snippet`,
   `branch_content`, and `why` (or "no reason recorded" if `why=null`, with a
   manual "generate why" action). A "switch to this branch" action on any
   non-active fork sets `is_active=true` on it and `is_active=false` on its
   siblings — descendant `is_active` values are preserved as remembered
   decisions on that branch (intentional). Backend recomputes via `/resolved`,
   editor updates to reflect the new active path.

## The `why` Field

`why` is nullable. A fork with `why=null` is fully valid — this occurs for
rejected forks (never reached approval), forks reactivated via switch-branch,
and forks where async generation failed.

**Lifecycle:**
- Generated asynchronously after approve via `POST /fork/:id/why`
- `status=resolved` + `is_active=true` happen atomically at approval;
  `why` is populated afterward, no new status value needed
- In-flight `why` writes complete and save regardless of subsequent branch
  switches — `why` belongs to the fork row permanently
- Switch-branch reuses whatever `why` is already on the row (no auto-generation)
- Tree view shows `why=null` as "no reason recorded" with a manual
  "generate why" button — never blank or broken-looking

**`POST /fork/:id/why`**
- Calls Granite with `original_snippet` + `branch_content`, structured output
  `{"why": "..."}`
- Hard length cap before persisting
- Idempotent — overwrites existing `why` on repeat calls
- Failure returns error + retry affordance; `why` stays `null`, no status
  regression on the fork
- Guarded by same `NODE_ENV !== 'production'` dev cache as other Granite calls

## Reliability & Failure Handling

Build this alongside P2–P3, not as an afterthought.

- **Input caps:** reject any selection/generation request over ~2000
  characters before it reaches Granite. Return a clear validation error.
  Enforced server-side (not just client-side).
- **Server-side timeout** on the Granite call (~20s). On timeout, the fork
  auto-transitions to `status=failed` and the document auto-unlocks — a
  pending fork must never lock the document indefinitely.
- **Manual cancel action:** while a fork is proposed and awaiting the Granite
  response or user review, expose a "cancel" action that marks it failed and
  unlocks the document immediately, without waiting out the timeout.
- **Manual force-unlock:** `POST /document/:id/force-unlock` — a single
  `UPDATE forks SET status='failed' WHERE document_id=? AND status='proposed'`.
  No cascade, no parent state changes. Resolution walk already skips non-active
  forks regardless of status. Safety hatch for live demo situations — no
  auth/polish needed, it just needs to work.
- **Race protection** relies on the DB partial unique index, not
  application-level checks, as the actual guarantee against concurrent
  duplicate forks.
- **Dev-only response cache:** cache Granite responses to avoid burning API
  quota on repeated identical test requests. Covers both Granite call types.
  Keys are hashed (collision-safe): alternative generation →
  `hash(original_snippet + instruction_template_id)`, why generation →
  `hash(original_snippet + branch_content + instruction_template_id)`.
  Guarded by `NODE_ENV !== 'production'`. Does not ship in the final build.

## Stack

- **Frontend:** React + Tiptap (live text editor with real selection handling)
- **Backend:** Node/Express
- **Database:** SQLite (with partial unique indexes for lock/active-fork invariants)
- **AI:** IBM Granite via watsonx.ai
  - Auth via a dedicated token-manager module (IAM key → bearer token
    exchange, cached, auto-refreshed before ~1hr expiry — never inline in
    route handlers)
- **Rate limiting:** in-memory token-bucket per session (server-issued httpOnly
  session cookie as identity; `Map<sessionId, tokenBucket>`, wiped on restart),
  on the alternative-generation endpoint only
- **Env/secrets:** `.env` + `.gitignore` committed in the first scaffold
  commit, before any key is pasted in. Watsonx key never touches frontend
  code/bundles.
- **CORS:** `CORS_ORIGIN` in `.env`, read at Express startup
  (e.g. `CORS_ORIGIN=http://localhost:5173` for dev). For demo deployment,
  React build is served statically from Express (same origin); `CORS_ORIGIN`
  unset → CORS middleware disabled entirely. No hardcoded ports in source.

## API Surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/document/:id/resolved` | Segment array of resolved document |
| GET | `/document/:id/tree` | Flat list of all fork rows |
| PATCH | `/document/:id/edit` | Direct edit or append within a segment |
| POST | `/document/:id/generate-alternative` | Insert proposed fork, call Granite; body: `{ segment_fork_id, anchor_start, anchor_end, selected_text, instruction?: string }` |
| POST | `/fork/:id/approve` | Approve fork (atomic), unlock document |
| POST | `/fork/:id/reject` | Reject fork, unlock document |
| POST | `/fork/:id/cancel` | Cancel proposed fork, unlock document |
| POST | `/fork/:id/why` | Generate (or regenerate) why field async |
| POST | `/fork/:id/switch` | Switch active branch at this fork's level |
| POST | `/document/:id/force-unlock` | Mark pending fork failed, unconditional unlock |

## Scope for This Build

- No auto-detection of decision points — user manually selects text and
  requests an alternative.
- New forks can only be created on the currently active path (selecting within
  a single active segment).
- No multi-user collaboration, no auth beyond the force-unlock safety hatch —
  single-session, single-document demo is fine.
- No persistence requirements beyond SQLite surviving a dev session.
- Drift detection is a stretch goal only — not built until P1–P4 are fully
  working.

## Phased Delivery

| Phase | Deliverable | Status |
|---|---|---|
| P1 | Single hardcoded document seeded with sample text. Live editor with ~500ms autosave debounce, editing `root_content` when no forks exist. `GET /document/:id/resolved` returns segment array. | ⬜ |
| P2 | Segment-aware selection (cross-segment rejected). Flush debounce before fork ops. `POST /generate-alternative` with optional `instruction` field (free-form or preset chip), structured-output extraction, input cap, 20s timeout, `status=failed` on bad parse. Lock document, show original vs. proposed side-by-side. Session cookie issued for rate limiter. | ⬜ |
| P3 | Approve (atomic `is_active`/sibling swap/`status=resolved`, immediate unlock, async `why` via `POST /fork/:id/why`). Reject. Cancel. Force-unlock. `PATCH /document/:id/edit` with coordinate-space-scoped offset shifting. Append-at-end detection. | ⬜ |
| P4 | Tree/map view from `GET /document/:id/tree`. Clickable nodes showing `original_snippet`, `branch_content`, `why` (with "no reason recorded" + manual generate-why for `why=null`). Working switch-branch (sibling swap only, descendant state preserved). | ⬜ |
| P5 (stretch) | Drift detection — compare new content against past resolved forks' `why` reasoning, flag a plain-language contradiction without auto-editing | ⬜ |

Build and verify each phase before moving to the next.
