# Theme Settings and DevTools Workbench Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three persisted themes with Circuit Teal as default, a unified Settings surface, disciplined spacing and glass/gradient styling, and a DevTools workbench that can create, fully edit, and replay Mock requests.

**Architecture:** Persist a semantic `theme` identifier in `Settings` and apply it at the document root from the shared store subscription; all hosts consume one CSS token system. Reuse the existing `RuleEditor` inside DevTools for both existing rules and new virtual endpoints instead of creating a reduced editor. Extend captures with a deliberately small replay descriptor and execute replay in the inspected page, keeping request history immutable.

**Tech Stack:** React 18, TypeScript, Chrome DevTools API, Manifest V3, CSS custom properties, Vitest, Vite.

## Global Constraints

- Default theme is `circuit`; supported themes are `signal`, `circuit`, and `slate`.
- Theme variants must share one layout and semantic token set; no duplicated theme-specific component rules.
- Use spacing tokens for modified layouts; do not combine container `gap` with compensating child margins on the same axis.
- Glass is limited to navigation, popovers, modals, and contextual inspector chrome; form and code content use opaque surfaces.
- DevTools must support new override rules, new virtual endpoints, and full rule/variant editing through the same `RuleEditor` as Options.
- “重新发送” repeats the HTTP request for Mock verification; it does not reproduce the application callback or original user action.
- Replay must reject unsupported bodies explicitly rather than silently sending a different request.

---

### Task 1: Persist and apply theme settings

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/store/defaults.ts`
- Modify: `src/core/store/migrate.ts`
- Modify: `src/ui/useStore.ts`
- Test: `tests/migrate.test.ts`

**Interfaces:**

- Produces: `ThemeId = 'signal' | 'circuit' | 'slate'` and `Settings.theme: ThemeId`.
- Guarantees: old stores heal to `circuit`; invalid imported values heal to `circuit`; every host sets `document.documentElement.dataset.theme` from the live store.

- [x] Add migration tests for missing and invalid theme values.
- [x] Add `theme` to the shared type and default settings.
- [x] Heal the value in `migrate` without incrementing schema version because Settings already use additive self-healing.
- [x] Apply theme changes from `useStore` and remove the attribute during teardown only when no store was loaded.
- [x] Run `npm test -- --run tests/migrate.test.ts`.

### Task 2: Build unified Settings and three-theme token system

**Files:**

- Create: `src/hosts/options/AppSettings.tsx`
- Modify: `src/hosts/options/Options.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**

- Consumes: `Settings`, `UPDATE_SETTINGS`, existing `McpSettings`.
- Produces: Settings modal with Appearance, Request capture, and AI/MCP sections; theme preview cards write immediately through one explicit Save action.

- [x] Add a Settings entry to the Options navigation and keep MCP as a subsection rather than a competing top-level toolbar button.
- [x] Implement three palette cards and make Circuit Teal selected by default.
- [x] Move capture enabled/max count/page size controls into Settings; retain current values until Save.
- [x] Define `--space-1` through `--space-8`, semantic color tokens, gradient tokens, glass tokens, and opaque content tokens.
- [x] Restrict glass/gradient use to app canvas, sidebar, header, modal, popover, selected-state aura, and primary action.
- [x] Verify focus, dark-scheme behavior, and reduced motion.

### Task 3: Capture replay-safe request data

**Files:**

- Modify: `src/shared/messages.ts`
- Modify: `src/hosts/inject/index.ts`
- Modify: `src/core/mcp/redact.ts`
- Test: `tests/inject.test.ts`
- Test: `tests/redact.test.ts`

**Interfaces:**

- Produces: optional `CapturedRequest.replay` containing `headers`, `body`, and `bodyUnavailable`.
- Guarantees: string and URLSearchParams bodies replay exactly; unsupported FormData/Blob/stream bodies set `bodyUnavailable`; MCP redacted captures never expose replay headers or request body.

- [x] Add inject tests for fetch and XHR method/header/string-body capture.
- [x] Add tests proving unsupported bodies are marked unavailable.
- [x] Attach replay metadata to both mocked and real captures without consuming a `Request` body stream.
- [x] Ensure MCP redaction maps only the existing response-facing fields and add a regression assertion.
- [x] Run inject and redaction tests.

### Task 4: Upgrade DevTools into a full Mock workbench

**Files:**

- Modify: `src/hosts/devtools/PanelApp.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**

- Produces: `EditorTarget = { kind: 'new'; draft: RuleDraft } | { kind: 'existing'; ruleId: string }` and `replayRequest(entry): Promise<ReplayResult>`.
- Reuses: `RuleEditor` with `initial` for existing rules and `initialDraft` for new rules.

- [x] Replace the draft-only editor state with mutually exclusive new/existing editor targets; save existing targets through `SAVE_RULE_DRAFT`.
- [x] Add toolbar actions for a blank Mock and “新建虚拟接口”, scoped to the active project.
- [x] Add “完整编辑规则” in request details and rule rows; open the same editor used by Options.
- [x] Add “重新发送” using `chrome.devtools.inspectedWindow.eval` with JSON-encoded URL/options and visible success/failure feedback.
- [x] Disable replay with an explicit reason when the captured body is unavailable.
- [x] Keep “本次响应” immutable while the editor changes current Mock state.
- [x] Apply the approved DevTools structure: request rail, Trace Rail, contextual actions, and full-height editor.

### Task 5: Tighten Options layout and validate spacing

**Files:**

- Modify: `src/hosts/options/Options.tsx`
- Modify: `src/hosts/options/RuleEditor.tsx`
- Modify: `src/ui/styles.css`
- Modify: `docs/architecture/workbench-ui-review.md`

**Interfaces:**

- Produces: low-frequency action menu, sticky editor header, progressive advanced response section, and documented spacing ownership.

- [x] Move clipboard/import/replace/export into one overflow-safe “更多” menu.
- [x] Keep one spacing owner per axis: shell grid gap, section padding, form stack gap, and inline control gap.
- [x] Remove incidental inline margins from the touched toolbar and inspector sections and replace them with named layout classes.
- [x] Preserve resizable Inspector width and ensure the variant menu renders through a viewport portal.
- [x] Update design review with the selected multi-theme and glass/gradient decisions.
- [x] Run all tests, typecheck, production build, Markdown link validation, and `git diff --check`.
- [x] Render Options and DevTools prototypes at representative widths and revise once after visual inspection.
