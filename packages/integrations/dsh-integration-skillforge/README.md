---
description: "In-process SkillForge learning, guard, recovery, and postcondition behavior for users and maintainers configuring or debugging the DeepSeek Harness integration."
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-skillforge

English | [中文](README.zh.md)

## Summary

Use this package to collect tool-call trajectories, derive repeated successful call paths, block calls with missing or invalid arguments, and return deterministic recovery or postcondition guidance to the model. It stores derived records through `storageDomain` and keeps a synchronous JSONL mirror for abrupt headless exits. The integration makes no external network call of its own, but command postconditions can run local Bash. It is not enabled by a shipped profile and must be mounted explicitly.

## Table of Contents

- [Use this package](#use-this-package)
- [Multi-client evolution](#multi-client-evolution)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount SkillForge after a composition provides `storageDomain`, `systemPrompt`, and `tools`; the plugin registers its own `ctx.skillforge` service and opens the `skillforge` storage domain unless disabled.

### When to choose it

Choose SkillForge when repeated tool workflows should yield reusable call-path hints and when deterministic argument, failure, and postcondition checks are useful. Avoid it when no durable storage backend is available, when synchronous filesystem mirroring is unacceptable, or when command postconditions must run on a host without Bash.

### Minimal configuration

This row assumes the surrounding composition already mounts the required storage, prompt, and tool services:

```yaml
- name: '@deepseek-ai/dsh-integration-skillforge'
  config:
    projectName: 'my-project'
```

| Field | Default | Meaning |
|---|---|---|
| `disabled` | `false` | Skip domain opening and all listener registration while retaining the row |
| `projectName` | `dsh` | Scenario label stored with trajectories and used to separate mined skills |
| `collectTrajectories` | `true` | Persist completed turns and run ingestion and mining |
| `ruleGuard` | `true` | Deny tool calls missing schema-required or learned-required arguments, or violating declared enums |
| `recoveryHints` | `true` | Attach deterministic classification and recovery guidance to failed tool results |
| `skillInjection` | `true` | Add usable learned paths to the system prompt |
| `postconditions` | `[]` | File or command checks evaluated at turn end |
| `minSupport` | `2` | Minimum repeated-path count required for a mined skill |
| `minPathLength` | `2` | Shortest contiguous successful call path considered by mining |
| `maxPathLength` | `5` | Longest contiguous successful call path considered by mining |
| `minSessionsForInjection` | `2` | Distinct-session evidence required before a skill reaches the prompt |
| `maxStoredTrajectories` | `500` | Maximum domain trajectories retained; oldest records are pruned first |
| `minMiningIntervalMs` | `30000` | Minimum time between eager mining passes |
| `skillOverrides` | `{}` | Skill-name to lifecycle-status pins applied after scoring |
| `maxRevisionsPerSkill` | `5` | Snapshot revisions retained for each skill name |
| `skillRollback` | `{}` | Skill-name to revision restores reapplied before mining |

Each postcondition supplies `kind`, `target`, `expected`, and `message`. Supported kinds are `file_exists`, `file_contains`, `file_not_contains`, and `command_output_contains`; the last runs `bash -lc <target>` with a 15-second timeout. `SkillForgeConfig` is currently a TypeScript interface rather than a runtime Schemastery schema, so this table and [`src/index.ts`](src/index.ts) are the accepted-field reference.

### Run from this checkout

Install the root workspace dependencies and provide model credentials. The environment-variable form below is suitable for a temporary shell; never commit the key:

```sh
pnpm install
export DEEPSEEK_API_KEY='<your-key>'
```

The checked-in [`examples/headless.patch.yml`](examples/headless.patch.yml) mounts SkillForge directly from this source checkout. It keeps the two-run support and cross-session thresholds, sets a distinct scenario name, and removes the 30-second mining interval so a short demonstration can mine immediately. Inspect the effective composition before running a model:

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge/examples/headless.patch.yml \
  --dump-config
```

The final composed row should have `id: integration-skillforge` and a `file://` URL ending in `packages/integrations/dsh-integration-skillforge/src/index.ts`. Start one task with the same overlay:

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge/examples/headless.patch.yml \
  "Inspect package.json and README.md, then summarize this package. Use at least two tools."
```

This command creates one persisted Session, prints the agent result, and exits. SkillForge has no separate port or dashboard; its effects appear in tool behavior, model context, logs, and the persisted records described below. Run the same command again to provide a second Session. When both runs contain the same successful contiguous path of at least two tool calls, the example thresholds allow that path to become a prompt-injection candidate on a later run.

### Observe behavior and persistence

The JSON storage backend writes the domain under `DSH_HOME` and defaults to `~/.dsh`. After a completed run, inspect the domain and synchronous mirror with:

```sh
sed -n '1,240p' "${DSH_HOME:-$HOME/.dsh}/storages/skillforge.json"
tail -n 20 "$HOME/.dsh/storages/skillforge-events.jsonl"
```

Look under the domain document's `tables` object. The following records distinguish the main effects:

| Effect | Observable evidence |
|---|---|
| Completed turn collection | `tables.trajectories` gains a record, and the JSONL mirror gains a line containing `record` |
| Repeated-path mining | `tables.skills` and `tables.skill_revisions` gain records; the mirror also gains lines with `type` equal to `skill` or `revision` |
| Learned-path injection | `tables.injections` records the skill names surfaced to the model; the next matching request receives the learned tool-call section documented under Model Experience |
| Invalid argument guard | The log contains `skillforge: blocked ...`, and the model receives a tool error beginning `SkillForge precheck:` |
| Failed tool recovery | `tables.failures` gains the classified failure, and the model can receive a synthetic recovery message beginning `SkillForge classified ...` |
| Failed configured postcondition | `tables.verifications` gains the failed check, the log contains `skillforge: verification failed ...`, and that turn is excluded from successful-path evidence |

Run the same headless command after the first process exits to exercise restart behavior. Startup opens the existing domain and replays the mirror before registering collectors; when info logging is visible, a non-empty replay reports `[skillforge] mirror replayed <n> turns into trajectories`. Domain puts use stable turn keys, so replay repairs missing writes without creating a second record for the same turn.

`DSH_HOME` changes the JSON domain location but does not change the mirror location: the current implementation always uses `$HOME/.dsh/storages/skillforge-events.jsonl`. The mirror includes trajectory arguments and results as well as mined skill records, so treat it as potentially sensitive application data and apply host access and retention controls. The example's `minMiningIntervalMs: 0` is for observation only; use the 30-second default or a measured deployment value for normal operation.

### Runtime data and lifecycle

The service opens seven domain tables: `trajectories`, `failures`, `rules`, `skills`, `verifications`, `injections`, and `skill_revisions`. Completed turns are reconstructed from session events. Failed calls are classified and distilled into records; verified successful calls feed contiguous-path mining; scoring determines whether a mined skill is `canary`, `active`, degraded, or offline. The service closes its opened domain through a Cordis effect when its plugin fiber is disposed.

The plugin also appends replay records synchronously to `~/.dsh/storages/skillforge-events.jsonl`. On the next start it replays entries while preserving each scenario label, repairing domain writes that may not have drained before a short-lived headless process exited.

-----

<a id="multi-client-evolution"></a>
## Multi-client evolution

This core service shares one skill bank across Sessions in the same process and uses distinct Session ids for its injection gate. It does not own authenticated client identity, tenant isolation, or distributed multi-writer coordination. Do not interpret `minSessionsForInjection` as proof that evidence came from independent clients.

Use the [`@deepseek-ai/dsh-integration-skillforge-multiclient`](../dsh-integration-skillforge-multiclient/README.md) companion when client-attributed evidence and isolated evolution scopes are required. The companion does not edit this package's `src/` implementation. Its checked-in headless overlay keeps this core's collection, guards, recovery, and verification active while setting `skillInjection: false`; the companion then owns distinct-client promotion and scope-filtered path injection.

The implemented phase coordinates concurrent Sessions inside one DSH process and persists them through a separate `skillforge_multiclient` domain. Production client quorum requires a trusted gateway adapter to bind authenticated client and tenant or team identities; the Session-as-client fallback is for runnable evaluation. Cross-process and cross-host federation remain outside this phase.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runtime has two learning paths. The failure path reconstructs failed calls, applies a deterministic keyword classifier, stores evidence, and prepares recovery guidance. The success path profiles parameters from successful calls, mines repeated contiguous call windows, computes confidence and cost scores, and injects only `canary` or `active` skills that meet the cross-session threshold.

The pre-execution guard combines the registered tool schema with learned templates. Schema-required and learned-required arguments treat an absent key or an empty string as missing; enum checks use the registered schema. Turn-end postconditions are evaluated before mining, and any failed check excludes that turn from successful evidence while preserving the trajectory for audit.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Service lifecycle, listeners, storage, replay, guards, and model-context injection |
| [`src/tracker.ts`](src/tracker.ts) | Session-event reconstruction into complete turn records |
| [`src/classifier.ts`](src/classifier.ts) | Deterministic failure classification |
| [`src/distiller.ts`](src/distiller.ts) and [`src/recovery.ts`](src/recovery.ts) | Failure records, repair steps, and recovery guidance |
| [`src/profiler.ts`](src/profiler.ts), [`src/miner.ts`](src/miner.ts), and [`src/scoring.ts`](src/scoring.ts) | Parameter templates, repeated-path mining, and lifecycle scoring |
| [`src/verifier.ts`](src/verifier.ts) | File and Bash postcondition checks |
| [`src/spec.ts`](src/spec.ts) | Versioned domain declaration and record schemas |
| [`examples/headless.patch.yml`](examples/headless.patch.yml) | Source-checkout overlay for the documented headless demonstration |
| — | No runtime invariant companion is published: the integration owns one service instance and its private caches, while durable record validation belongs to `storageDomain` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tools subsystem](../../../docs/subsystems/tools.md) — pre-execute denial and post-execute context semantics.
- [Storage group](../../storage/README.md) — the storage hub, backends, and domain form used for durable records.
- [System prompt package](../../core/system-prompt/README.md) — ordered prompt-section assembly.
- [Testing policy](../../../docs/testing.md) — package-level regression, Loader composition, and coverage expectations.
- [Preserved learning notes](LEARNING_NOTES.md) — the original Chinese study notes kept outside the package contract.
- [Engineering change log](CHANGELOG.md) — concrete integration and verification changes made without editing the core implementation.

-----

<a id="model-experience"></a>
## Model Experience

### Learned tool-call system prompt section

#### What the model sees

When at least one usable skill meets `minSessionsForInjection` and the optional runtime scope permits its scenario, the model receives the section below with up to eight skills ordered by confidence. Concrete historical argument values are not included.

##### Learned path section

```markdown
Learned tool-call patterns from past successful sessions:
- <scenario>: <toolA> -> <toolB> (support=<count>, sessions=<count>, confidence=<percent>%).
Prefer these call chains for matching tasks; they skip re-planning.
```

#### Token effect

Zero tokens when no skill qualifies. Otherwise the system prompt grows by a fixed header and footer plus at most eight one-line path summaries; path length and names make the exact size data-dependent.

#### KV Cache effect

Replacing at section order `550`: a change to usable skills, evidence counts, confidence, scope filtering, or manual status controls changes this system-prompt segment and invalidates reuse from that segment onward. An unchanged skill set produces stable text.

### Pre-execution denial result

#### What the model sees

A denied tool call returns a `SkillForge precheck: <tool> ...` reason naming missing schema-required arguments, missing learned-required arguments, or enum violations, followed by a repair hint. Calls that pass every check receive no SkillForge text.

#### Token effect

Conditional and bounded by the relevant argument names and enum values. The denial replaces execution with one error result; it does not add text to successful calls.

#### KV Cache effect

Append-only for the next request: the denial result follows the existing reusable request prefix. Different argument names or enum values change only the newly appended result.

### Recovery and postcondition context

#### What the model sees

After a failed tool result, the model can receive a synthetic user message naming the deterministic failure type, recommended recovery action, and repair steps. After a failed turn-end postcondition, the next step can receive a synthetic user message naming the failed target, expected condition, and configured message.

#### Token effect

Zero for successful calls and verified turns. Each triggered message is data-dependent and retained in session history; multiple failed postconditions are joined with newlines for the next step.

#### KV Cache effect

Append-only when guidance first appears, so the previously sent prefix remains reusable. Once retained in session history, later requests repeat the same historical text until ordinary session compaction or truncation changes it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are part of the current integration behavior and should guide deployment choices.

- **No runtime config schema** — `SkillForgeConfig` is TypeScript-only, so Loader configuration is not normalized or rejected through Schemastery before service initialization.
- **Linear paths, not general DAGs** — mining considers contiguous windows of successful calls; it does not learn branches, joins, or causal dependencies.
- **Process-global mirror location** — the JSONL mirror is fixed at `~/.dsh/storages/skillforge-events.jsonl`, uses synchronous appends, and has no package-owned retention limit.
- **Best-effort async domain writes** — ingestion and mining issue non-awaited table operations so short-lived headless processes can exit; recovery relies on mirror replay and is not a transactional commit across all seven tables.
- **Bash-dependent command verification** — `command_output_contains` blocks the event path for up to 15 seconds and requires a local `bash`; use file checks for portable compositions.
- **Runtime-only scenario scoping** — `setScopeScenarios` accepts opaque live scope objects and cannot be declared in YAML; unregistered scopes receive every qualifying scenario.
- **Manual composition only** — no shipped profile or bundle enables the integration, so deployments must provide its three required services and mount the row explicitly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The core implementation is intentionally frozen for the current hardening pass. Manifest alignment, aggregate build registration, contract documentation, and regression tests may change around it; changes to the learning, guard, recovery, persistence, or injection algorithms require a separate decision and evaluation cycle.

</details>
