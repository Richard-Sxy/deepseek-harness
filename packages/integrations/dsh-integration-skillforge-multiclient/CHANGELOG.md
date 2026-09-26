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
- Registered the service and its public API types in the generated Cordis catalog, skills subsystem reference, capability-seam graph, and event producer-consumer matrix.
- Added the Loader packages used by the composition test to the package's declared development dependencies and workspace lockfile importer.

### Verification

| Check | Result |
|---|---|
| `tsc -b packages/integrations/dsh-integration-skillforge-multiclient --pretty false` | Passed. |
| Focused Vitest run for `multiclient.spec.ts` and `loader-composition.spec.ts` | Passed: 2 files and 5 tests. |
| Focused Oxlint run for the package `src` and `tests` trees | Passed with no findings. |
| `tsdown -F @deepseek-ai/dsh-integration-skillforge-multiclient` | Passed and emitted `lib/index.js` plus declarations. |
| Plain Node import of the built `lib/index.js` | Passed; the default export was `SkillForgeMulticlientService`. |
| `publint packages/integrations/dsh-integration-skillforge-multiclient` | Passed with the repository-standard warning that development-only `./src/*` exports are not packed. |
| `gen-tsconfig-paths.ts --check` and `verify-package-dependencies.ts` | Passed. |
| Headless `dsh` profile plus `examples/headless.patch.yml` with an isolated `DSH_HOME` and `--dump-config` | Passed; both source plugins resolved and the coordinator settings were active. |
| Package README translation pairing | Passed. |
| `pnpm run test:docs` | Passed: 20 gates, 0 failures, 0 skipped. |
| `pnpm run doc-sync` | 39 of 41 gates passed. The only failures are 67 export-JSDoc findings and 6 config-catalog findings under the frozen base `dsh-integration-skillforge/src` tree. The new package's block typecheck, generated Cordis catalog, graphs, bilingual pairing, site build, and other documentation gates passed. |
| `pnpm run lint` | The Host build completed, then Oxlint reported 26 findings, all under the frozen base `dsh-integration-skillforge/src` tree. The focused new-package lint passed. |

No real-model task was executed during verification, so no API credential or external service was required. The Loader composition test proves mount behavior, focused service tests prove collection, quorum, isolation, injection, restart, retention, and failure handling, and the headless dump proves the documented launch overlay resolves through the supported `dsh` launcher.
