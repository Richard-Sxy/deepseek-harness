# SkillForge integration change log

## 2026-09-22 — Repository integration hardening

### Scope and frozen surface

This change hardens the package around its evaluated implementation. It does not edit any file under `packages/integrations/dsh-integration-skillforge/src/`. Existing worktree changes in that directory were preserved as user-owned core work. Algorithm changes to classification, profiling, mining, scoring, recovery, verification, persistence, and prompt injection remain outside this change.

### Changes made

- Aligned `package.json` with the repository release version and public-package metadata, added the missing `@deepseek-ai/dsh-agent` dependency, moved runtime `zod` into `dependencies`, removed the unused direct `dsh-storage` declaration, and added Loader test dependencies.
- Updated the package TypeScript references to match actual source imports, registered the package in `tsconfig.host.json`, and added its non-generatable package-name alias to `tsconfig.base.json`.
- Updated `pnpm-lock.yaml` from the package manifest and restored workspace links with the existing lockfile.
- Added deterministic contract tests for failure classification, required-parameter handling, schema enums, parameter profiling, verified-path mining, scoring, recovery guidance, and isolated file postconditions.
- Added a real Cordis Loader composition smoke test for the default Service export and the `disabled: true` no-startup path.
- Kept the Loader smoke assertion compatible with the aggregate host typecheck by resolving the service through `Context.get`.
- Replaced the former study-note README with a package contract covering configuration, runtime data, lifecycle, model-visible effects, KV-cache behavior, and known limitations.
- Added a source-checkout headless overlay and synchronized bilingual operator instructions for startup, behavior observation, restart replay, and persistence inspection.
- Added a separate multi-client companion package for client-attributed evidence and evolution-scope isolation without modifying this package's evaluated core source.
- Preserved and clarified the former Chinese study content in `LEARNING_NOTES.md`.
- Added the `integrations/` group README pair, registered the group in the root package maps, and refreshed both translation-pairing records.

### Verification

| Check | Result |
|---|---|
| `vitest run` on the two SkillForge specs | Passed: 2 files, 9 tests |
| `tsc -p packages/integrations/dsh-integration-skillforge/tsconfig.json --noEmit` | Passed |
| `tsc -b packages/integrations/dsh-integration-skillforge --force` | Passed; emitted package declarations and intermediate JavaScript |
| `tsdown -F @deepseek-ai/dsh-integration-skillforge` | Passed; produced `lib/index.js` |
| Plain Node import of `lib/index.js` | Passed; the default export is a Service constructor |
| `publint packages/integrations/dsh-integration-skillforge` | Completed successfully; it reports the repository-standard `./src/*` development export as absent from the packed `files` list |
| `oxlint packages/integrations/dsh-integration-skillforge/tests` | Passed |
| `gen-tsconfig-paths.ts --check` | Passed |
| `verify-package-dependencies.ts` | Passed: 65 checked packages match the published dependency policy |
| `check-workspace-constraints.ts` | Exited successfully; it also printed existing notices for unrelated empty package locations in this checkout |
| `pnpm run test:docs` | Passed: 20 documentation gates, including Markdown links, bilingual pairing, README summary/model-experience/limitations, budgets, and prose checks |
| `pnpm run doc-typecheck` | Passed after the aggregate-safe Loader test assertion update: 82 blocks compiled |
| `pnpm run doc-sync` | Ran: 37 gates passed; the remaining graph, export-JSDoc, and config-catalog failures require changes to generated documentation or the frozen `src/` surface and were left unchanged |
| `pnpm run lint` | Ran after the aggregate build passed; 74 findings remain in the frozen SkillForge `src/` files and were left unchanged |
| `pnpm dsh --profile headless --patch ./packages/integrations/dsh-integration-skillforge/examples/headless.patch.yml --dump-config` | Passed with an isolated `DSH_HOME`; the overlay resolved to the package source entry after the required base services |
| Scoped `git diff --check` for the files changed by this hardening pass | Passed |

### Frozen-source validation status

The package-wide `oxlint` command is not clean because the pre-existing frozen `src/` worktree has lint findings in `classifier.ts`, `distiller.ts`, `index.ts`, `miner.ts`, `profiler.ts`, `schema.ts`, `tracker.ts`, and `verifier.ts`. The full `git diff --check` also reports pre-existing trailing whitespace in `src/miner.ts:125` and `src/tracker.ts:140`. These findings were left unchanged to honor the no-core-modification constraint; the new tests, manifests, configs, and documentation are clean under their focused checks.
