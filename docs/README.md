# Aylachi documentation

This directory describes the code that exists in the current checkout. It distinguishes observed implementation from accepted production gates.

## Read in this order

1. [Architecture](architecture.md) — process and module ownership.
2. [Security and recovery](security-and-recovery.md) — trust boundaries, effects, snapshots and limitations.
3. [Development](development.md) — setup, tests, browser fixtures, builds and review gates.
4. [UI contract](ui-contract.md) — how Node Views should behave and how to add one.
5. [Roadmap](roadmap.md) — implemented vertical slices and remaining work.

## For coding agents

Before changing behavior:

1. Read the owning module and its tests, not only the repository overview.
2. Identify the durable state, external effect, retry identity and recovery path affected by the change.
3. Check `runtime/development-state.mjs` and `runtime/offline-snapshot.mjs` when adding or changing a database.
4. Keep generic contracts out of UI components and keep transport out of pure Node Views.
5. Add a regression that fails for the original reason, then make the smallest compatible fix.
6. Update the relevant documentation in the same diff.

Source code and tests are authoritative. When documentation disagrees with them, verify the behavior and correct the documentation in the same change.
