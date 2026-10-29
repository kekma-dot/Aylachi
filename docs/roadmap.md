# Current roadmap and known gaps

This roadmap reflects the current checkout, not production approval.

## Implemented vertical slices

| Slice | Current implementation |
|---|---|
| M0 — UI baseline | Chat workspace controls, model settings and native restore |
| M1 — Event Plane | Live text/tool activity, durable/transient separation and SSE resume |
| M2 — Tool Effects | Checkpoints, approvals, recovery and explicit unknown states |
| M3 — Workspace Graph | Multi-node definitions, edges, runs and artifact correlation |
| M4 — Artifact Engine | Markdown/Mermaid/HTML, sources, versions, export/rollback and Pi adapter |
| M5 — Backends/plugins | Conversation backend pinning and trusted plugin lifecycle |
| M6 — Memory/channels | Route CAS, acting principal, inbox/outbox and promotion-gated proposals |
| M7 — Browser/themes | Browser policy/snapshots, Theme Editor and review-gated theme proposals |

These entries describe implemented code, not production-readiness guarantees. Consult the verification boundaries below and the current test suite before relying on a capability.

## Remaining broad roadmap

- **Real adapters:** Telegram/Hermes transport, ACP/additional execution backends and a real local-interactive browser transport.
- **Distributed resources:** authenticated Satellite, Fast RPC/Durable Job, leases, reconnect reconciliation and offline policies.
- **Full plugin vertical slice:** manifests, selective installation, Plugin Host, sandbox enforcement, staged updates and rollback for unknown plugins.
- **Complete Canvas MVP gate:** simultaneous desktop clients, Activity Center, Focus/Collapse and unknown-plugin Node Views.
- **Knowledge and Skills:** derived FTS/backlinks/watchers, Hermes read-only integration, context packages/ACL and validated versioned Skill activation.
- **Production hardening:** formal security gates, owner sign-off, backup/restore drills, metrics, cross-OS UI and performance/accessibility on dense real workspaces.
- **Expansion:** more integrations and optional Model/Harness Arena after the MVP gates.

## Current verification boundaries

- Synthetic adapters do not prove real external transports.
- Static reverse engineering does not prove runtime behavior.
- Trusted plugin lifecycle is not a third-party plugin sandbox.
- Browser-local interaction is not native WKWebView verification.
- Passing tests and builds do not themselves authorize merge, publication or canonical promotion.
