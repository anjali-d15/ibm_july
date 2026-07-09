# AGENTS.md — Agent (Coding) Mode

This file provides guidance to agents when working with code in this repository.

## Coding Rules (Non-Obvious)

- **Never inline token fetching.** All watsonx IAM → bearer exchanges go through the dedicated `token-manager` module. Route handlers must import it, never call IAM directly.
- **DB partial unique index is the lock.** Do NOT add app-level "check if pending fork exists before inserting." The partial unique index (`WHERE status='proposed'`) is the real guard; duplicate checks create a race window.
- **Character offsets only.** Use `doc.textBetween()` for all anchor calculations — not ProseMirror internal positions. Any helper that computes `anchor_start`/`anchor_end` must use this method.
- **Granite structured output, always.** Prompt must explicitly request `{"alternative": "..."}` JSON only. Parse defensively: missing field or invalid JSON → set `status=failed`, never store partial/garbled content.
- **`/resolved` after every mutation.** After any approve/reject/switch-branch mutation, the caller must re-fetch `GET /document/:id/resolved` and replace the editor content. Never compute the resolved document client-side.
- **Siblings become inactive on approve.** When a fork is approved (`is_active=true`), all other forks sharing the same `(document_id, anchor point)` must be set `is_active=false` in the same transaction.
- **Rejected forks are never deleted.** `status=resolved`, `is_active=false` — stored permanently so tree view can show them.
- **Rate limiter placement.** Token-bucket middleware goes only on the alternative-generation endpoint, not globally.
- **Dev cache:** Granite response cache (keyed on `selected_text + instruction`) is a dev-only flag. It must not run in production — guard it with `NODE_ENV !== 'production'`.
