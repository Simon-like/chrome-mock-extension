# MCP P0 Context and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make MCP page context tab-correct, bound response-body reads, and persist MCP settings before any client install or copy action.

**Architecture:** Reuse the existing capture store's `tabId` and the Hub/Peer bridge; add an active-tab query only to `get_page_context`. Put body shaping and UTF-8 chunking in a pure core module so the MCP tool remains a thin adapter. Make the settings dialog await the existing `UPDATE_SETTINGS` command before opening a deeplink or copying connection configuration.

**Tech Stack:** TypeScript, React 18, Chrome MV3 APIs, MCP TypeScript SDK, Vitest, MCP stdio/WebSocket e2e.

## Global Constraints

- Do not change the Hub/Peer transport or bridge protocol version.
- Keep host whitelist filtering and mandatory redaction in the extension before data crosses the bridge.
- Preserve the untracked `chrome-mock-extension.code-workspace`; do not add or commit it.
- `get_request_detail` defaults to `body_mode: "schema"`; raw body reads must be explicit and bounded.
- Body chunks must obey UTF-8 byte limits and must not split a Unicode code point.
- Non-idempotent request replay, doctor, installer changes, and UI editor expansion are outside this P0 implementation.
- Run unit tests, MCP e2e, typecheck, and production builds before committing.

---

### Task 1: Active-tab page context

**Files:**
- Modify: `src/shared/bridge.ts`
- Modify: `src/hosts/background/mcpBridge.ts`
- Modify: `mcp-server/src/tools.ts`
- Modify: `mcp-server/e2e.mjs`

**Interfaces:**
- Consumes: existing `getCaptures(tabId?: number)` and `redactCapture`.
- Produces: `GET_CAPTURES.activeTab?: boolean`, capture response `page: RedactedPage | null`, and `get_page_context` output `page`.

- [x] **Step 1: Write the failing e2e fixture and assertions**

Add a capture from `tabId: 99`, give normal captures `tabId: 7`, and make the fake extension apply the same active-tab filtering as production. Assert:

```js
check(
  'get_page_context 只返回当前标签页',
  pageContextJson.page.id === 7 &&
    pageContextJson.requests.every((r) => r.tabId === 7) &&
    !JSON.stringify(pageContextJson.requests).includes('other-tab'),
);
```

- [x] **Step 2: Run e2e to verify it fails**

Run: `npm run e2e` in `mcp-server/`.
Expected: the new active-tab assertion fails because the tool currently reads all captures.

- [x] **Step 3: Implement active-tab bridge filtering**

Add these types:

```ts
export interface RedactedPage {
  id: number;
  title: string;
  url: string;
}

// GET_CAPTURES fields
activeTab?: boolean;

// captures response field
page?: RedactedPage | null;
```

In `mcpBridge`, resolve `chrome.tabs.query({ active: true, lastFocusedWindow: true })` only when `activeTab` is true. Pass the resulting ID into `visibleCaptures(tabId)`, which calls `getCaptures(tabId)`. Redact the page URL with the existing `redactUrl`; return `page: null` and no entries if there is no usable active tab.

In `get_page_context`, send `activeTab: true` and include `page: captureData.page ?? null` in its result. Explain in the tool description that the scope is the active tab in the last-focused Chrome window.

- [x] **Step 4: Run e2e and typechecks**

Run: `npm run e2e` in `mcp-server/` and `npm run typecheck` at repository root.
Expected: all assertions pass; no TypeScript errors.

- [x] **Step 5: Commit**

```bash
git add src/shared/bridge.ts src/hosts/background/mcpBridge.ts mcp-server/src/tools.ts mcp-server/e2e.mjs
git commit -m "feat(mcp): scope page context to active tab"
```

### Task 2: Bounded response detail reads

**Files:**
- Create: `src/core/mcp/responseDetail.ts`
- Create: `tests/responseDetail.test.ts`
- Modify: `mcp-server/src/tools.ts`
- Modify: `mcp-server/src/index.ts`
- Modify: `mcp-server/e2e.mjs`

**Interfaces:**
- Consumes: `RedactedCapture` from the bridge.
- Produces:

```ts
type BodyMode = 'schema' | 'sample' | 'full';
function presentCaptureDetail(
  entry: RedactedCapture,
  options: { mode: BodyMode; maxBytes?: number; cursor?: string },
): Record<string, unknown>;
```

- [x] **Step 1: Write failing pure-function tests**

Cover JSON object shape, array-first-item behavior, non-JSON fallback, null bodies, UTF-8 boundaries, cursor continuation, invalid cursors, and the 64 KiB hard cap. Key assertions:

```ts
expect(schema.body).toMatchObject({ type: 'object' });
expect(schema.bodyBytes).toBe(Buffer.byteLength(raw, 'utf8'));
expect(sample.body).toBe('你好');
expect(sample.returnedBytes).toBe(6);
expect(sample.nextCursor).toBeNull();
expect(continued.body).toBe('世界');
expect(() => chunk(raw, { cursor: '-1' })).toThrow('cursor');
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run tests/responseDetail.test.ts`.
Expected: FAIL because `responseDetail.ts` does not exist.

- [x] **Step 3: Implement the pure response presenter**

Strip `body` from common metadata, then add `bodyMode`, `body`, `bodyBytes`, `returnedBytes`, `sourceTruncated`, and `nextCursor`. For schema mode, parse JSON and return bounded type/shape information with short scalar examples; cap depth, object keys, and string examples. Arrays include their item count and only the first item's shape. Invalid JSON uses a bounded text preview.

For sample/full mode, treat the cursor as an opaque decimal character offset. Iterate with `for (const char of body)` and stop before adding a code point that would exceed `maxBytes`. Defaults: sample 8 KiB, full 16 KiB; hard maximum 64 KiB. `sourceTruncated` must retain the capture-layer truncation flag.

- [x] **Step 4: Wire and verify the MCP tool**

Add tool inputs:

```ts
body_mode: z.enum(['schema', 'sample', 'full']).optional(),
max_bytes: z.number().int().min(1).max(65536).optional(),
cursor: z.string().optional(),
```

Default to schema and call `presentCaptureDetail`. Update instructions to say schema is the default and full is explicit. Extend e2e to assert that the default does not return the raw JSON string, sample/full do, and a small `max_bytes` produces a continuable cursor.

Run: `npx vitest run tests/responseDetail.test.ts` at root, then `npm run e2e` in `mcp-server/`.
Expected: all tests pass.

- [x] **Step 5: Commit**

```bash
git add src/core/mcp/responseDetail.ts tests/responseDetail.test.ts mcp-server/src/tools.ts mcp-server/src/index.ts mcp-server/e2e.mjs
git commit -m "feat(mcp): add bounded response detail modes"
```

### Task 3: Save before connecting MCP clients

**Files:**
- Modify: `src/hosts/options/McpSettings.tsx`
- Modify: `src/hosts/options/Options.tsx`
- Modify: `docs/architecture/mcp-server.md` or the current MCP user documentation section that describes installation.

**Interfaces:**
- Consumes: existing `run({ type: 'UPDATE_SETTINGS' })`, which returns `CommandResult`.
- Produces: `McpSettings.props.onSave(patch): Promise<boolean>`; all install/copy actions run only after it resolves `true`.

- [x] **Step 1: Implement awaited save semantics**

Change the parent handler to return `res.ok`. In the dialog, build the patch once in an async `saveChanges` function, await it, track `saving` and an inline error, and never close or connect on failure.

- [x] **Step 2: Guard every connection action**

Use one helper:

```ts
const saveAndRun = async (action: () => void | Promise<void>) => {
  if (saving) return;
  const ok = await saveChanges();
  if (ok) await action();
};
```

Deeplinks prevent default navigation and set `window.location.href` only after save. Claude/local/manual copy actions use the same helper. Disable install and save buttons while saving. The normal Save button closes only after success.

- [x] **Step 3: Update user-facing documentation**

Document that client buttons and copy actions save first, so the token and port they contain are already active in the extension. Do not claim that a deeplink proves the AI client completed its first MCP call.

- [x] **Step 4: Run full verification**

Run at root: `npm test -- --run`, `npm run typecheck`, `npm run build`.
Run in `mcp-server/`: `npm run e2e`.
Expected: all unit and e2e tests pass; both builds succeed.

- [x] **Step 5: Review and commit**

Inspect `git diff --check`, `git status --short`, and the complete diff. Confirm the unrelated workspace file is not staged.

```bash
git add src/hosts/options/McpSettings.tsx src/hosts/options/Options.tsx docs/architecture/mcp-server.md docs/superpowers/plans/2026-10-25-mcp-p0-context-and-onboarding.md
git commit -m "fix(mcp): save settings before client onboarding"
```
