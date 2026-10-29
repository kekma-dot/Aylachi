# Security, recovery and trust boundaries

## Identity and authorization

Hub mutations require the trusted owner/actor context. Acting-user identity from a channel is accepted only through the trusted internal dispatch path, not as a caller-supplied public HTTP identity. UI controls are not security boundaries; server-side grants and routes remain authoritative.

## Effects and uncertain outcomes

Durable tool effects use checkpoints, idempotency identity, payload hashes, attempts and owner fencing. `SUCCEEDED` means the recorded exact receipt for that adapter, not a universal exactly-once guarantee. An interrupted or externally uncertain effect becomes `UNKNOWN`; it must not be silently retried or relabelled as success.

The same caution applies to channel delivery and memory promotion. Read-only reconciliation is preferred over repeating an effect whose result is unknown.

## Browser modes

- `remote-read-only` performs bounded HTTPS GET requests without credentials, with an exact host allowlist, redirect revalidation, content-type limits and text snapshots.
- `local-interactive` accepts snapshots only through a trusted adapter. Core does not obtain arbitrary browser control from this contract.

The current desktop creation action defaults to `allowedHosts: ['example.com']`; the Node View does not yet provide an allowlist editor. Browser capability therefore does not mean that an arbitrary website can be opened through the current UI. Other hosts require an explicit trusted creation/policy change.

A synthetic local snapshot adapter is test evidence, not proof of a real browser transport. Static REA analysis of another application is likewise not runtime evidence.

## HTML and themes

Artifact HTML Preview uses an isolated iframe and restrictive CSP. The native shell permits the app origin and exactly `about:srcdoc`; unrelated `about:blank`, `data:` and external navigation remain denied. Markdown originals and immutable HTML sources remain authoritative.

Theme changes accept only the schema in `themes/schema.mjs`: constrained colors, radius, shadow, typography and density. Agent proposals cannot activate themselves and cannot install CSS, JavaScript or executable plugins.

## State and offline snapshots

`runtime/development-state.mjs` owns the private state root, path checks, file permissions, locks and one-shot live approval. `runtime/offline-snapshot.mjs` uses an explicit file allowlist and exact SQLite schema checks. New durable stores must be added to both contracts and to non-empty snapshot/restore tests.

Snapshots exclude bearer tokens, auth files, cookies and arbitrary secrets. Never delete `.live-used` or another ownership marker to bypass a consumed approval.

## Plugins and external code

Dynamic code and mutating hooks are trusted code. Current plugin health/disable/dispose behavior does not establish filesystem, process or network isolation for an unknown plugin. A full plugin installer and sandbox remain separate roadmap work.
