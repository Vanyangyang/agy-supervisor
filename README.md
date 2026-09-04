# AGY Supervisor

AGY Supervisor is an independent Codex plugin for keeping an official Google Antigravity CLI headless conversation alive across MCP frontend reconnects. It freezes the selected model and effort per session, resumes only by the confirmed conversation ID, and never reads or copies AGY credentials.

This is an independent, unofficial project. It is not affiliated with or endorsed by Google or OpenAI.

It depends on the official Google Antigravity CLI `1.1.25` and on the current Windows user's existing interactive login. The plugin never reads, copies, or bypasses authentication.

## Safety boundaries

- Every managed AGY child explicitly uses `--dangerously-skip-permissions`. AGY tools, commands, and file writes are auto-approved. Use the plugin only for work you have already authorized and in a workspace you are prepared for AGY to modify.
- `effortStatus` value `ACCEPTED_NOT_ATTESTED` means the CLI accepted the requested `--effort` parameter. It does **not** mean Antigravity returned an attested thinking-strength measurement.
- On Windows, daemon launch uses PowerShell `-ExecutionPolicy Bypass` only so an ordinary-user detached process can start. That flag is **not** an elevation prompt and does **not** grant administrator rights.
- Version, SHA-256, and Authenticode signature gates fail closed. When a fixed version/hash/signature gate blocks an upgraded AGY binary, install a reviewed Supervisor release that pins the new runtime. There is no automatic bypass.

This repository does not claim legal, trademark, or policy review was completed.

## Install

Prerequisites: Windows, Node.js 20 or newer, and the official Google Antigravity CLI `1.1.25` already signed in interactively for the current user.

```powershell
codex plugin marketplace add Vanyangyang/agy-supervisor
codex plugin add agy-supervisor@agy-supervisor
```

From a repository checkout, the checked-in bundle can start a loopback-only read-only status panel:

```powershell
node .\plugins\agy-supervisor\dist\agy-supervisor.mjs panel
```

The panel inspects bounded Supervisor state and can copy a sanitized handoff JSON. It is not an Antigravity chat client.

Read the [plugin documentation](plugins/agy-supervisor/README.md) for runtime, authentication, persistence, cancellation, and safety details.

## License

[MIT](LICENSE)

Third-party notices for bundled dependencies are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
