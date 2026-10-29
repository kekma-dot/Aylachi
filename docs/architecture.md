# Architecture and module ownership

Aylachi is a harness-first system: durable control and recovery contracts come before specialized Node Views. It is not a collection of independent chat plugins.

## Control and execution

```text
Desktop UI / Pi tools
        |
        v
Authorized Hub API and module routes
        |
        +--> Durable stores and execution event journals
        +--> Workspace Graph definitions and runs
        +--> Runtime composition
                    |
                    +--> Managed Pi worker/backend
                    +--> Trusted optional adapters
```

- **Hub** owns authorized operations, event contracts and shared module APIs.
- **Runtime** owns worker lifecycle, private development state, trusted adapter composition and shutdown.
- **Agent Host / Pi adapter** owns SDK execution and native session continuity.
- **Desktop UI** is a client, not the authority for commands, runs or recovery.

## Durable domains

| Domain | Owner | Important contract |
|---|---|---|
| Conversations and execution events | `persistence/`, `hub/execution-events.mjs` | Durable lifecycle/final records are separate from transient deltas |
| Tool effects | `delegation/effects.mjs` | Checkpoint before effect, payload/attempt binding, exact receipt or explicit `UNKNOWN` |
| Workspace Graph | `workspace/` | Definitions, runs, attempts and artifacts are separate records |
| Artifact Engine | `artifact-engine/` | Immutable versions, source snapshots, idempotency, export and rollback-as-new-version |
| Backends | `backends/` | Conversation remains pinned to its backend/revision/session |
| Plugins | `plugins/` | Trusted descriptors, capabilities, generation fencing, health and disposal |
| Channels | `channels/` | Route CAS, acting principal, durable inbox/outbox and replay protection |
| Memory | `memory/` | Isolated proposals, independent review, trusted promotion and conflict states |
| Browser | `browser/` | Explicit backend/mode/policy, durable tabs and bounded snapshots |
| Themes | `themes/` | Declarative tokens, version history, workspace CAS and review-gated agent proposals |

SQLite databases are separate by domain. That separation is intentional modularity, not a requirement to merge them into a single store.

## Workspace Graph and Node Views

Workspace Graph owns `chat`, `wiki`, `artifact`, `browser` and `theme` definitions, context edges, run history and correlated artifacts. The React Flow registry maps those definitions to thin views:

- Chat commands execute only through explicit Chat operations.
- Pure Wiki/Artifact previews support `Run node`, `Run branch` and `Run all` against the required subgraph.
- Browser snapshots correlate to the Browser node that produced them.
- Artifact versions reference their originating Graph run/node/attempt.
- Theme changes are workspace state, not Graph execution side effects. The current UI edits them in Settings → Appearance; legacy Theme definitions can remain persisted but are not shown as Canvas nodes.
- Manual Handoff remains a backend capability for compatibility, but its manual transfer form is not exposed in the current workspace UI.

## Built-in but replaceable capabilities

Artifact, backend, plugin, channel, memory, Browser and Theme planes are composed by the runtime and advertised through capabilities. Built-in does not mean hard-coded into Chat: adapters and stores have explicit ownership and can be replaced through trusted composition without rewriting the UI or Core.

The current plugin plane accepts trusted, pre-registered descriptors. It is not an installer or security sandbox for unknown third-party code.
