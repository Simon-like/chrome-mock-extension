# Documentation Governance Restructure Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Turn the flat, chronological `docs/` folder into a durable documentation system for project constraints, product iterations, architecture evolution, feasibility experiments, user guidance, and delivery history.

**Architecture:** Use document responsibility—not creation time—as the primary directory boundary. Keep requirements and decisions immutable enough to preserve history, expose current truth through landing pages and global constraints, and give every evolving document an explicit lifecycle.

**Tech Stack:** Markdown, repository-relative links, shell-based link validation.

## Global Constraints

- Preserve the business and technical conclusions in the existing 13 documents; restructure and annotate them rather than silently rewriting history.
- `docs/README.md` is the single entry point for humans and AI agents.
- `docs/governance/global-constraints.md` is the authoritative source for project-wide invariants.
- Product requirements, architecture decisions, and feasibility experiments use independent IDs and lifecycles.
- Time-bound status and roadmap snapshots must not present themselves as current truth indefinitely.
- All repository-local Markdown links must resolve after migration.

---

### Task 1: Define the documentation model

**Files:**

- Create: `docs/README.md`
- Create: `docs/governance/documentation-policy.md`
- Create: `docs/governance/global-constraints.md`
- Create: `docs/governance/README.md`

- [x] Define the directory responsibilities and reading paths.
- [x] Define lifecycle states, authority rules, naming conventions, and update triggers.
- [x] Extract durable project constraints from the existing product and architecture documents.

### Task 2: Add reusable document templates

**Files:**

- Create: `docs/governance/templates/prd-template.md`
- Create: `docs/governance/templates/design-template.md`
- Create: `docs/governance/templates/adr-template.md`
- Create: `docs/governance/templates/spike-template.md`

- [x] Make every template record status, owner, dates, related artifacts, scope, decisions, and verification.
- [x] Make PRDs describe outcomes and acceptance criteria without duplicating design details.
- [x] Make design documents trace back to PRDs and forward to ADRs and validation.

### Task 3: Migrate the existing corpus

**Files:**

- Move product discovery and PRDs under `docs/product/`.
- Move architecture documents and decision history under `docs/architecture/`.
- Move experiments under `docs/experiments/`.
- Move user/developer guidance under `docs/guides/` and references under `docs/reference/`.
- Move dated roadmap and handoff documents under `docs/delivery/snapshots/`.

- [x] Replace chronological filenames with stable semantic names and IDs where lifecycle matters.
- [x] Add a compact document-control block to each migrated document.
- [x] Preserve old conclusions while marking superseded or historical material clearly.

### Task 4: Record architecture evolution

**Files:**

- Create: `docs/architecture/README.md`
- Create: `docs/architecture/decisions/ADR-0001-interception-strategy.md`
- Create: `docs/architecture/decisions/ADR-0002-core-and-command-boundaries.md`
- Create: `docs/architecture/decisions/ADR-0003-local-mcp-bridge-security.md`

- [x] Summarize the current system boundaries and evolution timeline.
- [x] Extract accepted architectural decisions into short ADRs with consequences and source links.
- [x] Distinguish current architecture truth from historical design proposals.

### Task 5: Repair navigation and validate

**Files:**

- Modify: `README.md`
- Modify: repository files that contain moved documentation paths.

- [x] Update every repository-local link and code comment that points at a moved document.
- [x] Verify there are no references to the old numbered filenames.
- [x] Validate every relative Markdown link under `README.md` and `docs/`.
- [x] Review `git diff --check` and the final documentation tree.
