# AGENTS.md — Plan (Architecture) Mode

This file provides guidance to agents when working with code in this repository.

## Architectural Constraints (Non-Obvious)

- **Lock invariant lives at DB layer.** The partial unique index `(document_id WHERE status='proposed')` is the architectural guarantee. Any plan that adds app-level locking on top of this introduces a race window, not additional safety.
- **Frontend is a dumb renderer.** No document resolution, no tree logic, no offset math happens client-side. The frontend receives a resolved string and a flat fork list — it does layout/rendering only.
- **Forks are append-only.** No row is ever deleted. Plans for "cleanup" or "pruning" are out of scope and would break tree view correctness.
- **New forks can only attach to the currently active path.** Forking off an inactive branch is explicitly out of scope for this build.
- **Single-document, single-session.** No auth, no multi-user, no persistence guarantees beyond a dev session. Plans that add user accounts or collaboration are out of scope.
- **Drift detection (P5) is stretch-only.** Do not plan work that depends on it existing, and do not build it until P1–P4 are fully verified.
- **Watsonx token lifecycle:** IAM token has ~1hr expiry; the token-manager must cache and auto-refresh. Plans that fetch a new token per request will exhaust IAM rate limits quickly.
- **Input cap is a hard gate.** ~2000 char selection cap must be enforced server-side before any Granite call, not just client-side — this is a reliability boundary, not just UX polish.
- **Phase gate:** each phase (P1→P4) must be verified working before the next begins. Do not plan parallel delivery of multiple phases.
