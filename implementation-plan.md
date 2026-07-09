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
| parent_fork_id | string, nullable | null if attached directly to root |
| anchor_start | integer | plain-text character offset, derived from Tiptap's `doc.textBetween()` — NOT raw ProseMirror positions |
| anchor_end | integer | see above |
| original_snippet | text | frozen snapshot of what was there |
| branch_content | text | AI-generated alternative |
| why | text | AI-drafted summary, editable/confirmable by user |
| status | enum | `proposed` \| `resolved` \| `failed` |
| is_active | boolean | true if this branch is currently live in the document |
| created_at | timestamp | |
| updated_at | timestamp | for debugging stuck locks |

### Database-level constraints
- Partial unique index: at most one `Fork` per `document_id` WHERE `status='proposed'`
- Partial unique index: at most one `Fork` per `(document_id, anchor point)` WHERE `is_active=true`
- Hard cap on `branch_content` / `why` length (prevents unbounded AI output from corrupting resolution or blowing up later drift-detection prompts)

## Tree Resolution — Server-Side Only

The frontend never computes tree logic.

**`GET /document/:id/resolved`**
Walks `root_content` and applies each `Fork` along the currently active path 
(`is_active=true` at each decision point, in order). Returns the resolved 
plain text plus the ordered list of active fork ids. The frontend calls this 
after every mutation (approve, reject, switch-branch) and simply re-renders — 
it does not resolve the tree itself.

**`GET /document/:id/tree`**
Returns the flat list of all `Fork` rows for this document (with 
`parent_fork_id`, `is_active`, `status`) so the frontend can build the visual 
map. Frontend only handles layout/positioning of this data — no content 
resolution happens client-side.

## Locking Behavior

Only one fork can be pending (`status=proposed`) at a time per document. 
While a fork is pending, the entire document is locked — no editing anywhere 
until it's resolved (approved, rejected, or failed). This avoids offset drift 
in `anchor_start`/`anchor_end` and avoids handling overlapping pending forks, 
which is out of scope for this build.

## Core Flow

1. Writer types directly into the editor (this is `root_content`, or the 
   currently resolved content if forks already exist).
2. Writer selects a range of text, clicks "show alternative."
3. Frontend immediately disables the "generate alternative" action 
   (optimistic UI lock) to prevent double-submission before the backend 
   responds.
4. Backend attempts to `INSERT` a new `Fork` row (`status=proposed`, 
   `is_active=false`) as a single atomic operation relying on the partial 
   unique index to reject a second concurrent pending fork — never a 
   "check then insert" pattern, to avoid a race window. If the insert is 
   rejected, return a clean "a fork is already pending" error.
5. Backend calls IBM Granite (via watsonx) with the selected text, explicitly 
   instructing it to return ONLY the replacement text as structured output 
   (e.g. `{"alternative": "..."}`) — no preamble, no multiple options, no 
   markdown. Backend parses defensively: if the response isn't valid/expected 
   structure, or the field is missing, the fork transitions to `status=failed` 
   rather than storing garbled content.
6. Document locks entirely. Frontend shows `original_snippet` vs. 
   `branch_content` side-by-side for review.
7. Writer approves or rejects:
   - **Approve:** `is_active=true` on this fork, `is_active=false` on any 
     sibling forks at the same anchor point, `status=resolved`. Backend also 
     generates a draft `why` (same structured-output and defensive-parsing 
     approach as step 5), which the writer can confirm or edit. Document 
     unlocks, frontend re-fetches `/resolved` and re-renders.
   - **Reject:** `status=resolved`, `is_active` stays `false`. Fork remains 
     stored and viewable in the tree. Document unlocks, unchanged.
8. **Tree/map view:** renders all forks as a navigable tree using 
   `/document/:id/tree` data. Clicking a node shows its `original_snippet`, 
   `branch_content`, and `why`. A "switch to this branch" action on any 
   non-active fork sets `is_active=true` on it (and `false` on siblings), 
   backend recomputes, editor updates to reflect the new active path. This 
   is the core "surf through past decisions and alternatives" interaction.

## Reliability & Failure Handling

Build this alongside P2–P3, not as an afterthought.

- **Input caps:** reject any selection/generation request over ~2000 
  characters before it reaches Granite. Return a clear validation error.
- **Server-side timeout** on the Granite call (~20s). On timeout, the fork 
  auto-transitions to `status=failed` and the document auto-unlocks — a 
  pending fork must never lock the document indefinitely.
- **Manual cancel action:** while a fork is proposed and awaiting the Granite 
  response or user review, expose a "cancel" action that marks it failed and 
  unlocks the document immediately, without waiting out the timeout.
- **Manual force-unlock:** a simple admin-only endpoint/button 
  (`POST /document/:id/force-unlock`) that marks any pending fork as failed 
  and unlocks the document unconditionally. Safety hatch for live demo 
  situations — no auth/polish needed, it just needs to work.
- **Race protection** relies on the DB partial unique index, not 
  application-level checks, as the actual guarantee against concurrent 
  duplicate forks.
- **Dev-only response cache:** during development, cache Granite responses 
  keyed on `(selected text + instruction)` to avoid burning API quota on 
  repeated identical test requests. Doesn't need to ship in the final build.

## Stack

- **Frontend:** React + Tiptap (live text editor with real selection handling)
- **Backend:** Node/Express
- **Database:** SQLite (with partial unique indexes for lock/active-fork invariants)
- **AI:** IBM Granite via watsonx.ai
  - Auth via a dedicated token-manager module (IAM key → bearer token 
    exchange, cached, auto-refreshed before ~1hr expiry — never inline in 
    route handlers)
- **Rate limiting:** in-memory token-bucket middleware, per-session, on the 
  alternative-generation endpoint specifically
- **Env/secrets:** `.env` + `.gitignore` committed in the first scaffold 
  commit, before any key is pasted in. Watsonx key never touches frontend 
  code/bundles.
- **CORS:** explicit allowlist config from the start (frontend dev server 
  and backend Express are different ports/origins locally)

## Scope for This Build

- No auto-detection of decision points — user manually selects text and 
  requests an alternative.
- No forking off inactive/non-live branches — new forks can only be created 
  on the currently active path.
- No multi-user collaboration, no auth beyond the force-unlock safety hatch — 
  single-session, single-document demo is fine.
- No persistence requirements beyond SQLite surviving a dev session.
- Drift detection is a stretch goal only — not built until P1–P4 are fully 
  working.

## Phased Delivery

| Phase | Deliverable | Status |
|---|---|---|
| P1 | Live editor with autosave, editing `root_content` when no forks exist yet | ⬜ |
| P2 | Select a range, request alternative via Granite (with structured-output extraction, input caps, timeout handling), lock document, show original vs. proposed side-by-side | ⬜ |
| P3 | Approve (set `is_active`, mark siblings inactive, generate/confirm "why", recompute via `/resolved`, unlock) or reject (unlock, fork stays stored). Includes cancel and force-unlock actions | ⬜ |
| P4 | Tree/map view rendering all forks, clickable nodes, working "switch to this branch" action | ⬜ |
| P5 (stretch) | Drift detection — compare new content against past resolved forks' `why` reasoning, flag a plain-language contradiction without auto-editing | ⬜ |

Build and verify each phase before moving to the next.