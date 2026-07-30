# Throughline

AI that remembers *why* you made a decision, not just *what* you changed.

Throughline is a writing workspace where every AI-assisted rewrite becomes a tracked, reversible decision instead of a silent edit. Nothing is ever overwritten without approval, nothing rejected is ever deleted, and every accepted change carries its own recorded reasoning, building a navigable decision tree of the choices behind a piece of writing.

Built for IBM's AI Builders Challenge.

**Team:** Anjali Dadlani ([@anjali-d15](https://github.com/anjali-d15)) and Ananya Sriram ([@anansri799](https://github.com/anansri799))

---

## Problem statement

Every long creative work, whether it's a novel, a script, or a single scene, is the sum of thousands of small decisions: does this character forgive him, does this line land colder, does this scene stay dark or lighten up. A writer makes the call, moves on, and by a few drafts later the reasoning is gone. Nobody, not even the original author, remembers *why* a choice was made.

Generative AI tools make this worse, not better. They're excellent at producing alternatives, but they have no visibility into which decisions were intentional, which were compromises, and which define the work's actual creative direction. They check new text against old text, never against the reasoning that produced it. That's why a deliberate stylistic choice gets flagged as an inconsistency, and why a rewrite that silently overwrites a paragraph is indistinguishable, to the tool, from one the author never wanted.

Roughly 86% of creative professionals already use generative AI in their workflow. Despite that, protecting their own voice and originality remains one of their top concerns, because today's AI is optimized for generation, not judgment. It remembers the words. It never learns the intent behind them.

## Solution description

Throughline keeps a permanent, navigable record of every creative decision made on a document:

1. **Write normally** in a live, autosaving editor.
2. **Select any passage** and ask for an AI-generated alternative, either a free-form instruction ("make this colder," "have her forgive him") or a context-aware quick chip that adapts to what's selected (the toolbar detects dialogue, character names, and conflict language and surfaces relevant presets instead of generic ones).
3. **Review side-by-side.** The alternative renders as a visual diff against the original, and nothing is applied until the writer decides. The document locks for that one passage while the decision is pending, so nothing shifts underneath it mid-review.
4. **Approve or reject.** Approving swaps the text in and prompts for a one-line "why," an AI-drafted rationale the writer can accept or rewrite. Rejecting discards the proposal, but the rejected alternative is never deleted; it stays in the tree, permanently visible and reversible.
5. **Browse the decision tree.** A dedicated view (with both a visual graph and a detailed list mode) shows every fork in the manuscript's history: every alternative tried, which one won, and why. It lets the writer switch which branch is currently "live" at any decision point, non-destructively, at any time.
6. **Consistency checking.** Because Throughline has a record of *why* past decisions were made, not just what changed, it can compare new writing against documented intent and ask a clarifying question instead of flagging a raw text mismatch. For example: *"Earlier you established she never forgives betrayal. Is this growth, or did it slip past you?"* It flags. It never auto-edits.

Beyond the core loop, Throughline is a full authoring workspace: multi-document management with per-user libraries, a collapsible manuscript sidebar (outline, stats, per-branch navigation, multi-format export to `.md`/`.txt`/`.docx`), an author focus mode, and account-based access so each writer's manuscripts and decision history are isolated to them.

## Selected challenge theme

**Reimagining creative industries with AI.** Throughline treats AI as a collaborator whose output is provisional and reviewable, not authoritative and silent, directly addressing the theme's call for creative tools that expand what's possible without displacing the creator's own judgment.

## AI approach and architecture

The document is modeled as a **decision tree**, not a flat file. The current state of a manuscript is the result of walking from an original root through whichever branch is marked "active" at each decision point. Rejected branches are never deleted; they remain addressable nodes in the tree, and switching which branch is active at any point recomputes the resolved document non-destructively.

**Resolution** happens entirely server-side via recursive descent: starting from the root, each active fork's edit is applied relative to *that level's* already-resolved text, then the walk recurses into any active children. An inactive fork's entire subtree is skipped, since its child forks' offsets are only meaningful relative to content that existed because the parent was active, so an inactive parent invalidates everything beneath it. The client never resolves the tree itself; it renders directly from a server-computed segment array.

**Locking and concurrency** are enforced at the database level, not in application logic. A partial unique index guarantees at most one pending decision per document at a time, which is what makes the offset math above safe. Guest and registered accounts are isolated by row-level `user_id` scoping on every document and fork query.

**The AI layer (IBM Granite via watsonx.ai)** is used in three distinct ways, each with structured JSON output and defensive parsing rather than trusting free-form model text:
- **Alternative generation:** takes the selected passage plus an instruction (free-form or a detected-context preset) and returns a single proposed rewrite.
- **Rationale drafting:** given the original and the accepted alternative, drafts the one-line "why" the writer confirms or edits.
- **Consistency analysis:** compares new content against the accumulated "why" history for the active decision path and returns a structured list of potential contradictions, each phrased as a question rather than an assertion.

**Auth and sessions** use cookie-based sessions (no JWT), SHA-256 password hashing, and `crypto.randomUUID()` guest identities. This was a deliberately minimal choice, since the goal was correctness and data isolation for a hackathon build, not a production auth stack.

### Stack
React and Tiptap on the frontend (precise text-offset selection via `doc.textBetween()`), Node/Express, SQLite (`node:sqlite`, no ORM), and IBM Granite via watsonx.ai.

## How IBM Bob was used

Bob was the primary development tool across the full build, not just for scaffolding:

- **Spec-driven planning before implementation.** Before writing the fork/tree data model, we used Bob's Plan mode together with a structured `grill-me` interview skill that walked through every branch of the design: offset coordinate spaces for nested forks, locking edge cases, race conditions, and what happens when a decision point occurs before another already-resolved one in the text, all before any code existed. This caught real, load-bearing bugs early, including a coordinate-space mismatch that would have corrupted nested-fork resolution, a document-lock design that would have made the editor unusable after the very first decision, and a cache-keying bug that would have silently corrupted dev-testing data.
- **Implementation via Agent mode,** building the schema, resolution engine, API routes, and frontend components directly from the reviewed specs.
- **Debugging via Ask mode and root-cause tracing,** rather than patching symptoms. Notable fixes traced to root cause this way include a Vite dev-proxy config missing an entire route prefix (`/fork`), which silently 404'd every approve/reject/switch call while looking like a data or routing bug; a database transaction error-handling bug that left forks stuck in a `proposed` state after a failed approve; a tree-layout rendering bug diagnosed with live runtime console instrumentation instead of guesswork, after two rounds of code-level hand-tracing failed to explain the visible symptom; and, later in the build, a missing `/auth` and `/documents` proxy entry that was the actual cause of a wave of "Unexpected end of JSON input" errors across the auth and document-switching flows.
- **Iterative, spec-checked feature growth.** Later features, including account isolation, the persistent three-zone header, context-aware instruction chips, the dual-mode (visual/list) decision tree, shimmer loading states, and the visual diff review panel, were each planned against the existing architecture rules (no JWT, cookie sessions only, database-level locking, `/resolved` recomputed after every mutation, rejected forks never deleted) before implementation, so new UI work never quietly violated the invariants the original grill-me session had established.

## Known limitations

- No auto-detection of decision points. The writer manually selects text to fork.
- New forks can only be created on the currently active path.
- Consistency checking is scoped to the active decision path against the full document, with a prompt-level (not structurally offset-scoped) mitigation against flagging content that predates a given decision.
- Auth is intentionally minimal (SHA-256, cookie sessions, no JWT/OAuth), sufficient for isolating per-user manuscript libraries in this build, but not intended as a production-grade auth system.

## Roadmap

- Auto-detection of likely decision points from raw prose
- Collaborative handoff and multi-user review of a single manuscript's decision history
- Structural (offset-scoped) consistency checking rather than prompt-level mitigation
- Expansion beyond writing. The same decision/reasoning model maps to a known, named gap in adjacent fields, such as "design rationale documentation" in UX/product design, or archival provenance in fashion design.

---

## Setup

```bash
git clone https://github.com/anjali-d15/ibm_july.git
cd ibm_july

# Backend
cd server
npm install
cp .env.example .env   # fill in WATSONX_API_KEY and WATSONX_PROJECT_ID
npm run dev

# Frontend (separate terminal)
cd client
npm install
npm run dev
```

Open the printed local URL. Continue as a guest or create an account. Each account gets three starter manuscripts to explore the decision-tree workflow immediately.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `WATSONX_API_KEY` | yes | IBM Cloud API key |
| `WATSONX_PROJECT_ID` | yes | watsonx.ai project UUID |
| `WATSONX_URL` | no | defaults to `us-south` |
| `PORT` | no | defaults to `3001` |
| `CORS_ORIGIN` | no | defaults to `http://localhost:5173` |