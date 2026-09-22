# SkillForge multi-client implementation change log

## 2026-09-22 — Same-process multi-client evolution

### Frozen core

This implementation adds a companion package and does not modify any file under `packages/integrations/dsh-integration-skillforge/src/`. The evaluated classifier, miner, scorer, guard, recovery, verification, and persistence implementation remains intact.

### Runtime changes

- Added the `@deepseek-ai/dsh-integration-skillforge-multiclient` Service plugin with a runtime Schemastery configuration.
- Added branded client and evolution-scope identities plus the public `bindSession`, `bindingOf`, and scope-limited `snapshot` APIs.
- Added the version-1 `skillforge_multiclient` storage domain with `bindings`, `evidence`, `skills`, and `injections` tables.
- Added Session-event collection that accepts only completed turns whose observed tool calls all returned successful results.
- Added contiguous path evidence, distinct-client, distinct-Session, and support promotion gates, deterministic ranking, per-scope retention, and full derived-skill rebuilds.
- Added evolution-scope filtering for prompt assembly; diagnostics without an Agent and unbound Sessions in `exclude` mode receive no shared paths.
- Added a service-owned operation queue, `session/flush` drain, retained background-failure reporting, bounded live trackers, bounded injection audits, startup recomputation under current settings, and queue drain before domain close.
- Added immutable rebinding rules so evidence cannot move between clients or scopes after collection begins.
- Added a Session-as-client fallback for runnable evaluation while documenting that trusted production quorum requires an authenticated adapter.

### Repository integration and documentation

- Registered the package in the workspace lockfile, TypeScript path map, and Host solution references.
- Added focused behavior tests and a real Cordis Loader composition test.
- Added a core-plus-coordinator headless overlay, bilingual package reference, model-experience contract, persistence inspection instructions, deployment limits, and this change log.
- Updated the integrations package map and the base SkillForge documentation to point to the companion implementation.

### Verification

The final commands and results for this implementation are recorded here after the focused package, documentation, build, and repository checks complete.
