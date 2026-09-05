# Changelog

## 0.3.0

### Added

- A loopback-only, read-only Supervisor status and handoff panel. It reads bounded state with GET/HEAD only and copies sanitized, no-side-effect handoff JSON.
- Session-list pagination through `nextCursor`, with `lastRunId` and up to five newest `recentRuns` metadata records per session.

### Changed

- `saveResultArtifact` remains an explicit opt-in: its default keeps terminal replies bounded and memory-only; `true` requests a controlled complete-final-reply artifact.
- The fail-closed AGY version, SHA-256, signature, and capability gates remain in place. Idempotency binds a stable `requestId` to the full request intent, including `saveResultArtifact`, so retries cannot change durable-result behavior.

### Verification boundary

- Local build and fake-child tests verify source and bundled behavior. They do not establish installed-plugin loading, real AGY authentication or runtime compatibility, a live daemon/browser panel, or a published release.
