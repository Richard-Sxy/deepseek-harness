---
description: "Multi-client evidence coordination, evolution-scope isolation, persistence, and operation for SkillForge deployments."
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-skillforge-multiclient

English | [中文](README.zh.md)

## Summary

Use this companion plugin when several clients or Sessions should contribute successful tool-path evidence to one SkillForge evolution pool without sharing results across tenants. It leaves `dsh-integration-skillforge/src/` unchanged, stores client bindings and shared evidence in its own domain, promotes a path only after the configured distinct-client, distinct-Session, and support gates all pass, and injects only the qualified paths belonging to the current Session's evolution scope.

## Table of Contents

- [Use this package](#use-this-package)
- [Client identity and isolation](#client-identity-and-isolation)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin after a composition provides `storageDomain` and `systemPrompt`. The checked-in example also mounts the evaluated SkillForge core with its own path injection disabled, so the core continues to collect trajectories, guard calls, and return recovery guidance while this package owns cross-client promotion and injection.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-integration-skillforge-multiclient'
  config:
    defaultScope: 'my-team'
    unboundSessionPolicy: 'session-client'
    minClients: 2
    minSessions: 2
    minSupport: 2
```

| Field | Default | Meaning |
|---|---|---|
| `defaultScope` | `shared` | Evolution scope assigned by the Session fallback |
| `unboundSessionPolicy` | `session-client` | Treat each unbound Session as one demo client; use `exclude` when a trusted adapter must bind every Session |
| `minClients` | `2` | Distinct client identities required to qualify one path |
| `minSessions` | `2` | Distinct Sessions required to qualify one path |
| `minSupport` | `2` | Total successful observations required to qualify one path |
| `minPathLength` | `2` | Shortest contiguous successful tool path stored as evidence |
| `maxPathLength` | `5` | Longest contiguous successful tool path stored as evidence |
| `maxEvidencePerScope` | `2000` | Oldest-first evidence retention cap for each evolution scope |
| `maxSkillsPerScope` | `16` | Highest-ranked qualified paths retained and injected for each scope |
| `maxInjectionsPerScope` | `1000` | Oldest-first prompt-injection audit retention cap for each scope |
| `maxTrackedSessions` | `256` | Live turn trackers retained before the oldest entry is evicted |

The Schemastery config rejects non-positive integer limits. Service construction also rejects `maxPathLength` below `minPathLength`. Deployment-varying thresholds and retention caps are configurable rather than fixed in the learning path.

### Run from this checkout

Install dependencies and provide the model key without committing it:

```sh
pnpm install
export DEEPSEEK_API_KEY='<your-key>'
```

Inspect the combined source-checkout composition before running it:

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge-multiclient/examples/headless.patch.yml \
  --dump-config
```

Run the same repeatable task twice. The example treats each new headless Session as one fallback client, so two successful Sessions can meet all three default demonstration gates:

```sh
pnpm dsh --profile headless \
  --patch ./packages/integrations/dsh-integration-skillforge-multiclient/examples/headless.patch.yml \
  "Inspect package.json and README.md, then summarize this package. Use at least two tools."
```

Run it a third time to let the new Session receive any qualified path from `demo-team`. The original SkillForge row has `skillInjection: false`, which avoids showing both the core Session-based hint and this package's client-gated hint in the same prompt.

### Observe persistence and effect

The JSON backend defaults to `~/.dsh`. Inspect the multi-client domain after each run:

```sh
sed -n '1,260p' "${DSH_HOME:-$HOME/.dsh}/storages/skillforge_multiclient.json"
```

The document contains four tables:

| Table | Evidence to look for |
|---|---|
| `bindings` | Session-to-client and Session-to-scope assignments, including whether the source was explicit or the Session fallback |
| `evidence` | Successful contiguous paths with their client, Session, turn, and scope attribution |
| `skills` | Paths that currently pass every configured promotion gate |
| `injections` | Per-Session audit records for qualified paths surfaced to the model |

The third run demonstrates model-visible behavior when `injections` gains a record. There is no separate dashboard in this package; the durable JSON is the current operator view, and the public `snapshot(scopeId)` method provides the same aggregate counts to a future Host or Web presenter without exposing records from another scope.

### Persistence and restart behavior

The service opens the `skillforge_multiclient` domain at schema version 1 and closes it after its queued work drains. `session/flush` also waits for the operation queue and reports retained background persistence failures. Restarting with the same `DSH_HOME` reloads bindings, evidence, qualified skills, and injection audits from the selected storage backend; startup reapplies current retention and promotion settings before listeners activate. No JSONL mirror is used by this companion.

Evidence keys are stable per Session, turn, window start, and window length, so replaying the same observation overwrites it instead of increasing support. Scope rebuilds run on one service-owned operation queue: interleaved Session events cannot observe a half-applied prune or promotion. Retention removes the oldest evidence deterministically by timestamp and record id, then recomputes that scope's complete qualified set.

-----

<a id="client-identity-and-isolation"></a>
## Client identity and isolation

`session-client` is an immediately usable demonstration policy, not an authenticated multi-client identity system. One browser or API client can create several Sessions, so production deployments that need independent-client quorum should set `unboundSessionPolicy: exclude` and bind the authenticated client identity before the first turn.

A trusted gateway or composition adapter calls the service API with branded identities:

```ts
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  EvolutionClientId,
  EvolutionScopeId,
} from '@deepseek-ai/dsh-integration-skillforge-multiclient'

await ctx.skillforgeMulticlient.bindSession(SessionId(sessionId), {
  clientId: EvolutionClientId(authenticatedClientId),
  scopeId: EvolutionScopeId(tenantOrTeamId),
})
```

An identical binding is idempotent. A stored fallback binding may be replaced by an explicit binding only before that Session contributes evidence. Any conflicting explicit binding, or any rebind after evidence exists, fails loud; this prevents evidence from moving between tenants after promotion accounting has begun.

The prompt provider requires an Agent-bound assembly and resolves its Session binding synchronously. Diagnostics without an Agent receive no multi-client paths. A bound Agent sees only skills whose `scopeId` exactly matches its binding, while promotion counts clients and Sessions only within that same scope.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The collector tracks `turn/start`, ordered `tool/call` events, correlated `tool/result` outcomes, and `turn/end`. Only a completed turn in which every observed call has a successful result contributes evidence. For each accepted turn, the service stores every contiguous path between `minPathLength` and `maxPathLength`; historical arguments and result content are deliberately excluded.

Promotion groups evidence by exact tool-name sequence inside one scope, then checks total support, distinct client count, and distinct Session count. Qualified paths are ranked by client count, Session count, support, and a deterministic signature. Rebuild replaces the whole derived skill set for that scope, so pruning or stricter thresholds cannot leave a stale path published.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Service API, Session collector, serialized persistence, promotion, scope filtering, and prompt injection |
| [`src/spec.ts`](src/spec.ts) | Versioned zod schemas for bindings, evidence, qualified skills, and injection audits |
| [`tests/multiclient.spec.ts`](tests/multiclient.spec.ts) | Distinct-client quorum, scope isolation, immutable rebinding, fallback identity, and prompt behavior |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Default-export activation through a real Cordis Loader composition |
| [`examples/headless.patch.yml`](examples/headless.patch.yml) | Runnable core-plus-coordinator headless composition |
| — | No runtime invariant companion is published: one service owns the domain, operation queue, trackers, and prompt registration; the storage domain validates durable records |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Qualified cross-client paths

#### What the model sees

When the current Agent has a binding and at least one path qualifies in that exact scope, the system prompt contains:

```markdown
Cross-client tool-call patterns verified in this evolution scope:
- <toolA> -> <toolB> (clients=<count>, sessions=<count>, support=<count>).
Use these de-parameterized paths only when they fit the current task; choose arguments from current context.
```

Only tool names and aggregate counts are included. Client ids, Session ids, scope ids, arguments, results, and historical task text never enter this section.

#### Token effect

Zero tokens for unbound Agents, empty scopes, and diagnostic assemblies without an Agent. Otherwise the section contains one header, up to `maxSkillsPerScope` one-line path summaries, and one instruction footer.

#### KV Cache effect

This section is placed immediately after the base SkillForge section at order `551`. Its text changes when qualification, ranking, or counts change, invalidating cache reuse from this segment onward; repeated assembly with the same scope state produces stable text.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Single process and one storage-domain writer** — the operation queue coordinates concurrent Sessions inside one DSH process. It is not a distributed lock, and the JSON backend must not be shared by multiple writers.
- **Fallback identity is Session identity** — the default is convenient for headless evaluation but does not prove that observations came from independent people, devices, or accounts. Use explicit authenticated bindings for production quorum.
- **No shipped Web identity adapter** — the service API is ready for a gateway adapter, but the current Web client does not supply an authenticated client or tenant id to this package. Until such an adapter is mounted, Web Sessions use the configured fallback or are excluded.
- **No built-in dashboard** — persistence JSON and `snapshot(scopeId)` expose operational state, but this package does not add client UI. A future UI must consume a scope-authorized Host projection rather than reading all domain records in the browser.
- **Linear paths only** — evidence represents contiguous tool-name sequences, not branches, arguments, causal dependencies, success quality, or general DAGs.
- **No cross-host federation** — multiple workers require an external coordinator or a storage backend with explicit multi-writer transactions, idempotent evidence ingestion, and tenant-aware authorization; this package intentionally stops at the stable same-process phase.
- **Model-visible snapshot fixture deferred** — the exact prompt output is pinned by the package behavior test. A repository recorded-session case still requires a deterministic profile route that can preseed this non-Session storage domain before replay.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Base SkillForge integration](../dsh-integration-skillforge/README.md) — evaluated core collection, guards, recovery, scoring, and persistence.
- [Architecture](../../../docs/architecture.md) — plugin extension points and the rule that new behavior stays outside the agent loop.
- [Storage group](../../storage/README.md) — storage backends and domain durability.
- [Testing policy](../../../docs/testing.md) — behavior, Loader composition, and model-visible snapshot expectations.
- [Engineering change log](CHANGELOG.md) — concrete files, compatibility decisions, and verification for this implementation.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package is the first same-process multi-client phase. Preserve the base SkillForge source and its evaluation result. Add an authenticated Web or API adapter as a separate provider of `bindSession`; add cross-process coordination only with an explicit transactional storage and authorization design.

</details>
