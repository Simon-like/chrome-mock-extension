# Workbench Prototype Review Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce three reviewable, interactive visual prototypes for the Options workbench and DevTools request inspector, while correcting the currently clipped variant popover.

**Architecture:** Keep the prototype isolated under `docs/prototypes/workbench-ui-demo/` so no unapproved visual system leaks into production. All three directions share one semantic DOM and differ only through design tokens, making palette comparison honest. Fix the production popover independently by rendering it at the document root with viewport-aware fixed positioning.

**Tech Stack:** Semantic HTML, CSS custom properties, vanilla JavaScript, React 18 portal for the production popover, TypeScript, Vite.

## Global Constraints

- Attached screenshots are usability evidence, not implementation instructions.
- Do not apply a full production Options redesign before the user selects a prototype direction.
- Preserve the vocabulary `本次响应`, `当前 Mock`, `请求时变体`, and `当前生效变体`.
- Motion must explain state changes, remain under 420ms, and respect `prefers-reduced-motion`.
- Prototype content must use realistic Mock Studio rules and variants rather than generic dashboard placeholders.

---

### Task 1: Fix the production variant popover boundary

**Files:**

- Modify: `src/ui/VariantSwitcher.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**

- Produces: a `document.body` portal with fixed, viewport-clamped coordinates and no clipping by the scrollable rule list.

- [x] Measure the trigger when the popover opens and on viewport resize/scroll.
- [x] Render the menu through `createPortal` and keep outside-click behavior intact.
- [x] Clamp horizontal position and choose above/below placement from available viewport space.
- [x] Run `npm run typecheck` and `npm run build`.

### Task 2: Build three comparable visual directions

**Files:**

- Create: `docs/prototypes/workbench-ui-demo/index.html`
- Create: `docs/prototypes/workbench-ui-demo/styles.css`
- Create: `docs/prototypes/workbench-ui-demo/app.js`
- Create: `docs/prototypes/workbench-ui-demo/README.md`

**Interfaces:**

- Produces: palette switcher for `signal`, `circuit`, and `slate`; view switcher for Options and DevTools; interactive variant menu, advanced section, inspector, and save feedback.

- [x] Build the shared Master-detail + contextual Inspector structure using realistic rule data.
- [x] Implement Signal Blue tokens: Ink `#18202C`, Canvas `#F4F7FB`, Surface `#FFFFFF`, Accent `#2563EB`, Warning `#B45309`, Error `#C2414B`.
- [x] Implement Circuit Teal and Slate Violet as token-only alternatives.
- [x] Build the compact DevTools layout with the Trace Rail and a non-clipping variant menu.
- [x] Document what to compare and the intended recommendation.

### Task 3: Demonstrate restrained motion

**Files:**

- Modify: `docs/prototypes/workbench-ui-demo/styles.css`
- Modify: `docs/prototypes/workbench-ui-demo/app.js`

**Interfaces:**

- Produces: 140ms popover reveal, 180ms view crossfade, 220ms inspector transition, 420ms one-shot Trace Rail pulse, and reduced-motion fallback.

- [x] Animate only state-bearing transitions, not ambient decoration.
- [x] Make switching a variant update the active label, rail node, and brief saved-state feedback.
- [x] Add keyboard focus states and Escape-to-close behavior.
- [x] Disable transitions under `prefers-reduced-motion: reduce`.

### Task 4: Render and review prototypes

**Files:**

- Create: `docs/prototypes/workbench-ui-demo/screenshots/signal-options.png`
- Create: `docs/prototypes/workbench-ui-demo/screenshots/circuit-options.png`
- Create: `docs/prototypes/workbench-ui-demo/screenshots/slate-options.png`
- Create: `docs/prototypes/workbench-ui-demo/screenshots/signal-devtools.png`

**Interfaces:**

- Produces: deterministic review images rendered from the prototype, not hand-composited artwork.

- [x] Serve the prototype locally and capture all four views at a consistent viewport.
- [x] Inspect palette contrast, hierarchy, menu boundaries, and text wrapping.
- [x] Revise the prototype once after visual critique.
- [x] Run `git diff --check` and leave the formal production redesign unmodified.
