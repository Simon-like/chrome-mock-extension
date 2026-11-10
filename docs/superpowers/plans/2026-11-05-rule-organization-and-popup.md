# Rule Organization And Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the popup focused on rules relevant to the active page, automatically organize AI-created and legacy rules into projects/groups, and make storage capacity visible and safe.

**Architecture:** Add one pure organization module in `core/store` that derives stable project/group placement from host and URL data. Schema migration and the MCP server both consume that module, while the popup independently builds a current-tab view from host scopes and captured rule hits. Storage writes remain atomic and expose a byte estimate against Chrome's local-storage quota.

**Tech Stack:** TypeScript, React 18, Chrome Extension Manifest V3 APIs, Vitest, MCP SDK with Zod.

## Global Constraints

- Preserve all existing rules and response bodies during cleanup; never delete or disable rules automatically.
- Rules with explicit project/group assignments remain untouched.
- Rules without enough host evidence remain global and are grouped by URL only; do not guess a domain.
- MCP-created rules default to automatic organization but keep explicit project/group overrides available.
- Popup current-page rules prioritize rules hit in the active tab, then host-scoped rules; unrelated global history is summarized instead of listed.
- `chrome.storage.local` capacity is byte-based, not a fixed rule count.

---

### Task 1: Shared Rule Organization

**Files:**
- Create: `src/core/store/organize.ts`
- Test: `tests/organize.test.ts`

**Interfaces:**
- Consumes: `MockStore`, `Rule`, and injected `idFactory: () => string`.
- Produces: `deriveGroupName(url: string): string`, `organizeLegacyRules(store: MockStore, idFactory: () => string): OrganizeResult`, and host/project lookup helpers used by MCP.

- [ ] **Step 1: Write failing grouping tests**

Cover technical-prefix stripping (`/gateway/api/jinying/...` → `jinying`), exact-host project reuse, global grouping when hosts are absent, and preservation of explicitly assigned rules.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx vitest run tests/organize.test.ts`

Expected: FAIL because `src/core/store/organize.ts` does not exist.

- [ ] **Step 3: Implement deterministic organization**

Create projects keyed by normalized host-pattern sets, create groups keyed by `projectId + derived name`, assign only ungrouped rules, and return counts for projects, groups, and rules changed.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/organize.test.ts`

Expected: PASS.

### Task 2: Legacy Data Cleanup Migration

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/store/migrate.ts`
- Modify: `src/hosts/background/stateManager.ts`
- Test: `tests/migrate.test.ts`

**Interfaces:**
- Consumes: `organizeLegacyRules` from Task 1.
- Produces: schema v3 stores and persisted migration output on first load.

- [ ] **Step 1: Add v2-to-v3 migration tests**

Assert host-scoped rules gain a matching project/group, unscoped rules gain only a global group, existing assignments stay unchanged, response/meta data remains intact, and migration emits a cleanup notice.

- [ ] **Step 2: Run migration tests and verify failure**

Run: `npx vitest run tests/migrate.test.ts`

Expected: FAIL because schema v3 and the migration are absent.

- [ ] **Step 3: Implement and persist migration**

Raise `CURRENT_SCHEMA_VERSION` to 3, register `migrations[3]`, call the shared organizer, and have `getState()` write migrated/healed data back when the stored version differs.

- [ ] **Step 4: Run migration tests**

Run: `npx vitest run tests/migrate.test.ts`

Expected: PASS with existing v1-to-v2 guarantees preserved.

### Task 3: MCP Automatic Placement

**Files:**
- Modify: `mcp-server/src/tools.ts`
- Modify: `mcp-server/src/index.ts`
- Modify: `mcp-server/src/prompts.ts`
- Modify: `skills/mock-rule-authoring/SKILL.md`
- Test: `tests/organize.test.ts`

**Interfaces:**
- Consumes: `deriveGroupName` and project lookup helpers from Task 1, existing `CREATE_PROJECT`, `UPDATE_PROJECT`, `CREATE_GROUP`, and `CREATE_RULE` commands.
- Produces: `create_mock` inputs `project_id`, `group_id`, and `auto_organize`, with automatic active-page/host placement by default.

- [ ] **Step 1: Extend organization helper tests**

Cover active-page hostname fallback, explicit host priority, existing project/group reuse, and global-group fallback when no hostname is available.

- [ ] **Step 2: Add MCP placement workflow**

Before creating a rule, resolve explicit IDs or derive a hostname from `hosts`/active page, create or reuse a scoped project and business-path group, then place the draft there with `meta.source = 'ai'`.

- [ ] **Step 3: Update AI guidance**

Document that project/group assignment is automatic, explicit IDs are optional overrides, and clipboard fallback should infer a stable project/group rather than always emitting `null`.

- [ ] **Step 4: Build MCP server**

Run: `npm --prefix mcp-server run build`

Expected: TypeScript and bundle build succeed.

### Task 4: Current-Page Popup

**Files:**
- Modify: `src/hosts/popup/Popup.tsx`
- Create: `src/core/store/pageRules.ts`
- Test: `tests/pageRules.test.ts`

**Interfaces:**
- Consumes: active tab hostname, active-tab capture `ruleId` values, store projects, and rule host scopes.
- Produces: `selectPageRules(store, host, hitRuleIds)` returning current-page rules plus hidden global-history counts.

- [ ] **Step 1: Write page-selection tests**

Assert recently hit rules lead, matching scoped rules follow, unrelated projects are excluded, and unhit unrestricted legacy rules are counted but hidden.

- [ ] **Step 2: Implement selection helper**

Reuse `matchHostScope`, preserve store priority inside equal relevance tiers, and return enabled/current-page counts for popup summaries.

- [ ] **Step 3: Refactor popup display**

Read the active tab and its captures, render a bounded “本页规则” list, show a compact hidden-history summary, and calculate virtual-interface warnings from current-page rules only.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/pageRules.test.ts`

Expected: PASS.

### Task 5: Storage Capacity And Safety

**Files:**
- Create: `src/core/store/storageUsage.ts`
- Modify: `src/hosts/background/stateManager.ts`
- Modify: `src/hosts/options/AppSettings.tsx`
- Modify: `src/hosts/options/Options.tsx`
- Test: `tests/storageUsage.test.ts`

**Interfaces:**
- Produces: `LOCAL_STORAGE_QUOTA_BYTES`, `estimateStoreBytes(store)`, and `formatBytes(bytes)`.
- Consumes: serialized `MockStore` and Chrome storage write errors.

- [ ] **Step 1: Write byte-estimation tests**

Assert UTF-8 byte counting, 10 MiB quota constant, and stable human-readable formatting.

- [ ] **Step 2: Implement storage utilities**

Use `TextEncoder` for serialized UTF-8 size and expose warning thresholds without introducing a fixed rule-count limit.

- [ ] **Step 3: Make writes failure-safe**

Persist before replacing the in-memory cache; convert quota failures into a normal failed command result so UI and MCP receive an actionable error.

- [ ] **Step 4: Show storage usage**

Pass the store to `AppSettings` and display rule count, estimated usage, percentage, and the explanation that large response bodies determine the practical rule limit.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/storageUsage.test.ts`

Expected: PASS.

### Task 6: Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/guides/mcp-usage.md`

**Interfaces:**
- Consumes: completed behavior from Tasks 1-5.
- Produces: user-facing documentation for auto-organization, popup semantics, migration behavior, and storage limits.

- [ ] **Step 1: Update product documentation**

Describe current-page popup filtering, automatic MCP placement, non-destructive v3 cleanup, and the byte-based storage limit.

- [ ] **Step 2: Run all tests**

Run: `npm test`

Expected: all Vitest suites pass.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: TypeScript, inject bundle, and extension bundle all succeed.

- [ ] **Step 4: Review final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only scoped implementation/documentation changes plus the pre-existing workspace file.
