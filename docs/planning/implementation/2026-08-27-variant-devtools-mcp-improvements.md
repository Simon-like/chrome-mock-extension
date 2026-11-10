# Variant, DevTools, and MCP Improvements Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix variant persistence, make the DevTools Mock panel unambiguous and fast for variant work, reduce MCP agent startup friction, and leave the larger management UI redesign as an explicit review artifact.

**Architecture:** Introduce a dedicated command for replacing an existing rule from an editor draft so draft indices and optional variant IDs are normalized in core. Record the request-time variant in captures, while DevTools separately exposes the rule's current active variant and one-click switch/create actions. Keep the existing MCP Hub/Peer transport, adding one task-level bootstrap tool rather than changing transport before review.

**Tech Stack:** React 18, TypeScript, Chrome Manifest V3, Vitest, MCP TypeScript SDK, CSS.

## Global Constraints

- Preserve the MAIN world `document_start` interception path and fail-open behavior.
- All persisted state changes must go through a serializable core Command.
- Existing MCP security boundaries remain unchanged: loopback-only, Origin + token validation, extension-side redaction.
- Do not perform the full management-panel visual redesign before its review document is accepted.
- DevTools wording must distinguish an immutable request-time snapshot from mutable current rule configuration.

---

### Task 1: Persist editor variants atomically

**Files:**

- Modify: `src/core/command/types.ts`
- Modify: `src/core/command/reducer.ts`
- Modify: `src/hosts/options/Options.tsx`
- Modify: `src/hosts/devtools/PanelApp.tsx`
- Test: `tests/variants.test.ts`

**Interfaces:**

- Produces: `SAVE_RULE_DRAFT { id: string; draft: RuleDraft }`.
- Guarantees: existing variant IDs remain stable, missing IDs are generated, and `draft.activeVariantIndex` is persisted as `rule.activeVariantId` in the same storage write.

- [x] Add a failing reducer test that edits two variants, selects index 1, and verifies `activeVariantId` survives migration/reload.
- [x] Add a failing reducer test that saves a newly added variant without an ID and verifies it receives an ID and becomes active.
- [x] Implement `SAVE_RULE_DRAFT` by materializing the draft, preserving the rule ID and runtime metadata, and updating `updatedAt`.
- [x] Replace editor misuse of `UPDATE_RULE` with `SAVE_RULE_DRAFT` in Options and DevTools.
- [x] Run `npm test -- --run tests/variants.test.ts` and expect all variant tests to pass.

### Task 2: Separate request-time response from current Mock state

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/engine/responder.ts`
- Modify: `src/shared/messages.ts`
- Modify: `src/hosts/inject/index.ts`
- Modify: `src/hosts/devtools/PanelApp.tsx`
- Test: `tests/responder.test.ts`

**Interfaces:**

- Produces: `MockResponse.variantId`, `MockResponse.variantName`, and optional `CapturedRequest.variantId` / `variantName`.
- DevTools labels: `本次响应` means the captured immutable response; `当前 Mock` means the currently active editable variant.

- [x] Add a failing responder test asserting the generated response identifies the active variant.
- [x] Return active variant identity from `buildResponse` and attach it to mocked fetch/XHR capture events.
- [x] Show both `请求时变体` and `当前生效` when they differ.
- [x] Rename the ambiguous tabs and replace explanatory prose with concise snapshot/config descriptions.
- [x] Reset unsaved source edits when the current active variant changes.

### Task 3: Add quick variant switch and creation to DevTools

**Files:**

- Modify: `src/hosts/devtools/PanelApp.tsx`
- Modify: `src/ui/VariantSwitcher.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**

- Consumes: `SET_ACTIVE_VARIANT` and `CREATE_VARIANT` commands.
- Produces: a compact current-variant control in request details; creating a variant copies the current active response and activates the new variant.

- [x] Render `VariantSwitcher` in the detail header whenever a request matched a rule.
- [x] Wire switching directly to `SET_ACTIVE_VARIANT`.
- [x] Wire `基于当前新增变体` to `CREATE_VARIANT` with a deterministic display name such as `变体 3`.
- [x] Keep the request snapshot visible after switching and mark that a refresh/retry is required for a new response.
- [x] Add focused styling for the snapshot/current-state distinction without beginning the full visual redesign.

### Task 4: Give each MCP agent a one-call bootstrap

**Files:**

- Modify: `mcp-server/src/tools.ts`
- Modify: `mcp-server/src/index.ts`
- Modify: `mcp-server/e2e.mjs`
- Modify: `docs/architecture/mcp-server.md`
- Create: `docs/architecture/mcp-v2-review.md`

**Interfaces:**

- Produces: read-only `get_page_context` with optional `url_filter`; returns status, recent unmocked/error requests, relevant rule summaries, redaction/read-side state, and explicit recommended next actions.

- [x] Register `get_page_context` as the preferred first call for underspecified page-data problems.
- [x] Fetch state and recent captures concurrently inside the server so the agent makes one MCP round trip.
- [x] Keep full bodies out of the bootstrap response; `get_request_detail` remains the deliberate second step.
- [x] Update server instructions and e2e expectations to prefer the bootstrap path.
- [x] Document that current Hub/Peer already supports multiple MCP client processes and that Service Worker dispatch serializes writes.
- [x] Evaluate configuration simplification options—published CLI, local installer, persistent daemon, native messaging—without changing transport in this batch.

### Task 5: Prepare the management UI review

**Files:**

- Create: `docs/product/prds/PRD-0003-workbench-usability.md`
- Create: `docs/architecture/workbench-ui-review.md`
- Modify: `docs/product/README.md`
- Modify: `docs/architecture/README.md`

**Interfaces:**

- Produces: reviewable scope, information hierarchy, vocabulary, visual token direction, wireframes, phased acceptance criteria, and explicit non-goals for the first batch.

- [x] Record the observed usability failures from both screenshots as evidence, not instructions.
- [x] Define the shared vocabulary: request snapshot, rule, active variant, response definition, generated result.
- [x] Propose a restrained developer-tool visual direction with one signature element tied to request flow.
- [x] Compare the current three-column management layout with two alternative layouts and recommend one.
- [x] Split implementation into a structural phase and a visual-polish phase so either can be reviewed independently.

### Task 6: Validate the batch

**Files:**

- Verify all modified source, test, MCP, and documentation files.

- [x] Run `npm test -- --run` and expect all extension tests to pass.
- [x] Run `npm run build` and expect typecheck plus both extension bundles to succeed.
- [x] Run `npm --prefix mcp-server run e2e` and expect bridge, security, multi-client, and tool tests to pass.
- [x] Validate all relative Markdown links under `README.md` and `docs/`.
- [x] Run `git diff --check` and review that unrelated workspace changes remain untouched.
