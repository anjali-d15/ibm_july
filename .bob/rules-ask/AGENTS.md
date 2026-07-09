# AGENTS.md — Ask (Documentation) Mode

This file provides guidance to agents when working with code in this repository.

## Documentation Context (Non-Obvious)

- **`implementation-plan.md` is the canonical spec.** It is the only source of truth for the data model, API contract, locking behavior, and phased delivery order. README is a stub.
- **Character offset ambiguity:** "positions" in this codebase always means plain-text character offsets from Tiptap's `doc.textBetween()`, not ProseMirror internal positions. These are different numbers for the same location.
- **`is_active` ≠ `status=resolved`.** A fork can be `status=resolved` and `is_active=false` (rejected, stored permanently) or `is_active=true` (approved, live in document). Don't conflate resolved/active.
- **Tree resolution is intentionally NOT in the frontend.** Any frontend code that computes the resolved document is a bug, not a feature. Resolution lives exclusively at `GET /document/:id/resolved`.
- **`updated_at` on Fork** exists only for debugging stuck locks — it has no business logic meaning.
- **`why` field** is AI-drafted but user-editable/confirmable; it is generated after approve, not before.
