# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project

**Ledger** — a writing app where every AI-assisted alternative becomes a node in a navigable decision tree. See [`implementation-plan.md`](implementation-plan.md) for the full spec. The project has not been scaffolded yet; no build/test commands exist.

## Stack

- **Frontend:** React + Tiptap (editor); character offsets from `doc.textBetween()` — NOT raw ProseMirror positions
- **Backend:** Node/Express
- **Database:** SQLite with partial unique indexes (the lock/active-fork invariants live at the DB layer, not app layer)
- **AI:** IBM Granite via watsonx.ai (structured output only — `{"alternative": "..."}`, never free-form)
- **Auth:** IAM key → bearer token via a dedicated `token-manager` module; never inline in route handlers

## Critical Architectural Rules

- **Tree resolution is server-side only.** `GET /document/:id/resolved` computes the active document. The frontend never resolves the tree — it re-fetches after every mutation and re-renders.
- **Lock via DB, not app logic.** The partial unique index (`status='proposed'` per document) is the actual concurrency guard — never a "check then insert" pattern.
- **Character offsets** use `doc.textBetween()` (plain-text offsets), not raw ProseMirror positions. This matters everywhere `anchor_start`/`anchor_end` are stored or read.
- **Granite responses must be parsed defensively.** If the response is missing/malformed, the fork transitions to `status=failed`, never stores garbled content.
- **One pending fork at a time.** While `status=proposed` exists on a document, the document is fully locked — no editing, no new forks.

## Data Model Non-Obvious Details

- `Fork.is_active` and `Fork.status` are separate: a rejected fork has `status=resolved`, `is_active=false` and is **kept** in the tree, never deleted.
- Partial unique index: at most one `is_active=true` fork per `(document_id, anchor point)` — siblings at same anchor are mutually exclusive.
- Hard cap on `branch_content`/`why` length (prevent unbounded AI output from corrupting future drift-detection prompts).
- `updated_at` on Fork is for debugging stuck locks only.

## Failure Handling (required, not optional)

- Input cap: reject selections > ~2000 chars before reaching Granite.
- 20s server-side timeout on Granite calls → auto-transition to `status=failed`, auto-unlock.
- Manual cancel action (marks fork failed, unlocks immediately).
- `POST /document/:id/force-unlock` — marks any pending fork as failed, unlocks unconditionally (no auth needed, safety hatch only).

## Dev-Only Patterns

- Granite response cache keyed on `(selected_text + instruction)` during development — do not ship.
- CORS explicit allowlist from the start (frontend dev port ≠ backend port).
- `.env` + `.gitignore` committed before any key is pasted in; watsonx key never touches frontend bundles.
- Rate limiting: in-memory token-bucket middleware, per-session, on the alternative-generation endpoint only.

## Phased Delivery

Build and verify each phase before moving to the next (P1 → P2 → P3 → P4 → P5 stretch). See [`implementation-plan.md`](implementation-plan.md) for phase definitions.
