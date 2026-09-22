---
description: "Package map for optional DeepSeek Harness integrations that combine existing capability seams into higher-level behavior."
kind: "package-group"
---

# integrations/ — optional composed integrations

English | [中文](README.zh.md)

## Summary

The `integrations/` group contains optional plugins that combine existing Harness services into higher-level behavior without changing the agent loop. These packages are mounted explicitly by deployments rather than enabled by the base bundle. Open the package README to review its required services, model-visible effects, persistence behavior, and operational limits before adding it to a composition.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group currently contains two integrations.

| Package | What it provides |
|---|---|
| [`dsh-integration-skillforge/`](dsh-integration-skillforge/) | Learns repeated successful tool paths, guards arguments, and returns failure or postcondition guidance |
| [`dsh-integration-skillforge-multiclient/`](dsh-integration-skillforge-multiclient/) | Coordinates client-attributed path evidence, isolated evolution scopes, durable promotion, and scope-filtered injection without changing the SkillForge core |

-----

<a id="related-documentation"></a>
## Related documentation

- [Architecture](../../docs/architecture.md) — extension points and the rule that new behavior belongs in plugins.
- [Tools subsystem](../../docs/subsystems/tools.md) — the execution waterfalls used by integrations.
- [Storage group](../storage/README.md) — durable non-session storage and domain records.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
