# UI and Node View contract

The goal is a quiet, predictable workspace. Keep the existing Aylachi visual language; improve interaction by removing ambiguity and unnecessary controls rather than restyling the product.

## Shared behavior

- Expose only actions supported by the discovered capabilities.
- Use truthful status. Static chrome must not claim a healthy Hub, successful run or completed external effect without evidence.
- Preserve user input across layout changes, preview edits and recoverable errors.
- Use explicit loading, empty, error and success states. Do not turn a committed success into a failure because an optional refresh or event publication failed.
- Prefer progressive disclosure for secondary settings. Keep the primary task and current system state visible.
- On laptop trackpads, two-finger scrolling pans the Canvas and pinching zooms. Ordinary scroll must not become zoom; text/panel scrolling keeps its local behavior.
- Do not add decorative buttons, fake streaming or automatic retries for uncertain effects.
- Manual Handoff forms are not part of the workspace UI. Future session-to-session transfer must use an automatic context/handoff flow rather than reintroducing manual source/command/target forms.

## Node View ownership

Node Views render authoritative data and call injected clients/callbacks. They do not own Graph execution, global routing or direct transport outside their scoped client.

Every definition node uses the shared `.card-heading` drag handle. Interactive content uses `nodrag`; scrollable content uses `nowheel` where needed so text input and preview interaction do not move the node or Canvas unexpectedly. Resize/move mutations carry the current revision and surface conflicts instead of silently retrying.

New node kinds belong in the existing registry in `desktop-ui/Canvas.jsx` and must also have Graph/store/route capability ownership. A new visual component alone is not a new executable node.

## Artifact and Browser content

- Markdown/Mermaid uses the existing Markdown renderer and lazy Mermaid loading.
- HTML uses the sandboxed Preview path; never inject artifact HTML into the application DOM.
- Artifact opens in rendered Preview by default. Source is a small secondary action, never the dominant initial view.
- Source and Preview are distinct views of the same current version; asynchronous definitions must refresh an open Preview, and empty HTML is not a perpetual loading state.
- Browser chrome stays limited to compact tabs/address/refresh controls. Links in read-only snapshots are evidence text, not promises of interactive browsing, and long link lists use progressive disclosure.

## Theme editing

- Themes live in harness **Settings → Appearance**, not in a Theme Node. Legacy persisted Theme definitions may remain in durable Graph state but are hidden from Canvas.
- Six built-in presets use stable `preset-*` identities. Selecting a preset creates or activates that exact preset; name matching is not identity.
- Preview is temporary; save/activate/disable/rollback are explicit operations.
- Agent proposals require human Accept or Reject.
- Changing the light/dark Base preserves compatible custom edits. Reset is a separate explicit action.
- Rollback defaults to the nearest previous version and creates a new version rather than rewriting history.

## Accessibility and verification

Use native buttons/forms/labels, visible focus, meaningful accessible names and keyboard-operable controls. Verify hit targets and scrolling in a real browser/native shell, not only SSR. Test long content, pending/error states and draft preservation with the same scenario before and after an interaction change.
