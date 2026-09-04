# AGY Supervisor

AGY Supervisor keeps a Google Antigravity CLI conversation available when an MCP frontend reconnects. It runs a small user-level daemon and uses AGY's documented `stream-json` stdin protocol, so prompts do not appear in the child process command line.

> [!IMPORTANT]
> This is an independent, unofficial project. It is not affiliated with or endorsed by Google or OpenAI. It depends on the official Google Antigravity CLI `1.1.25` and the current Windows user's existing interactive sign-in. The plugin never reads, copies, or bypasses authentication. It does not provide, export, or test credentials.

> [!WARNING]
> Every managed child uses `--dangerously-skip-permissions`. AGY tool calls, commands, and file writes are therefore auto-approved. Run it only for work you have already authorized and only in a workspace you are prepared for AGY to modify.

## What it guarantees

- A logical session keeps one exact AGY `conversation_id`, model, effort, workspace, and permission profile.
- A live daemon keeps the same AGY process warm across turns. After a safe restart it resumes only by the confirmed conversation ID; it never uses cwd-relative `--continue`.
- Before work is sent, the installed binary and private reference snapshot must match AGY `1.1.25`, the approved SHA-256, a valid Google Authenticode signature, and the required headless flags. The authenticated installed path is checked before it is queried, rehashed afterward, and checked again immediately before a new child is spawned; the reference snapshot is verified but not executed.
- Managed children receive `CI=true` and `AGY_CLI_DISABLE_AUTO_UPDATE=true`. This keeps the protocol non-interactive and prevents the Supervisor from turning a missing cached login into an account-picker workflow. The Supervisor observes upgrades but never runs an updater, installer, login, model-list, or credential command.
- AGY reads the current ordinary Windows user's existing profile and Credential Manager. Before each new child, the Supervisor refreshes its credential-free bootstrap environment and fills missing HTTP/HTTPS proxy routes from the enabled current-user Windows proxy setting. It never reads, copies, accepts, or logs credentials or credential-bearing proxy URLs; missing or locked authentication must still be repaired in an interactive AGY terminal.
- A model and effort are explicitly passed and frozen for the session. AGY reports the effective model in `init`. AGY 1.1.25 does not attest effective effort; `effortStatus` is `ACCEPTED_NOT_ATTESTED`, which means the CLI accepted the `--effort` parameter, **not** that Antigravity returned an attested thinking-strength measurement.
- Prompts and raw tool data are memory-only. The durable state contains hashes, byte counts, bounded lifecycle metadata, and confirmed conversation IDs—not raw prompts, responses, argv, environment, stdout, or stderr.
- RPC timeout is not cancellation. Cancellation targets only the exact child object owned by this daemon and has a bounded settlement deadline. Work whose completion is uncertain keeps its workspace fenced and is never replayed automatically; acknowledgment is refused while the recorded process identity is still alive.
- Local RPC requests and responses are authenticated with an epoch-bound HMAC over a token-derived pipe name. The reusable capability token remains in the user state directory and is not sent through the pipe, command line, status, or logs. This is a same-Windows-user boundary, not isolation from an administrator or another process already running as that user.

- On Windows, the daemon is launched as an ordinary-user detached process through PowerShell `-NoProfile -NonInteractive -ExecutionPolicy Bypass` plus the interactive desktop shell. `-ExecutionPolicy Bypass` is used only so that unsigned launch script can run for the current user. It is **not** User Account Control elevation and does **not** grant administrator rights.
- Version, SHA-256, and Authenticode signature gates fail closed. If a newer AGY binary is blocked by those pins, upgrade by installing a reviewed Supervisor release that updates the pins. There is no automatic bypass of hash/signature/version gates.

Every managed child explicitly uses `--sandbox --dangerously-skip-permissions` and must attest `always-proceed` before any prompt is sent. This auto-approves all AGY tool calls, including commands and file writes; the sandbox is not a substitute for permission review. Treat every session turn as a fully authorized writer for workspace-serialization purposes.

Version 0.3 serializes AGY turns by canonical workspace inside this Supervisor. It does not claim an atomic cross-process lock against Cursor Bridge or Grok Build Supervisor; the primary orchestrator must keep those independent writers serialized.

Durable history retains at most 500 full terminal runs plus 500 compact idempotency tombstones, and at most 200 open sessions. Reusing a request ID is protected inside that retention window; older evicted IDs are not a permanent global deduplication ledger.

This documentation does not claim the project is fully compliant, or that legal or trademark review was passed.

## Install in Codex

Prerequisites: Windows, Node.js 20 or newer, and the official Google Antigravity CLI `1.1.25` already signed in interactively for the current user.

```powershell
codex plugin marketplace add Vanyangyang/agy-supervisor
codex plugin add agy-supervisor@agy-supervisor
```

The Supervisor intentionally fails closed when the installed AGY executable does not match its pinned version, hash, Google Authenticode signature, or required headless capabilities. Upgrading AGY therefore requires a reviewed Supervisor release rather than an automatic bypass. See Google's [headless CLI documentation](https://antigravity.google/docs/cli/headless/) for the upstream protocol and flags.

## Common commands

From this plugin directory in a source checkout:

```powershell
node .\dist\agy-supervisor.mjs --help
node .\dist\agy-supervisor.mjs help session
node .\dist\agy-supervisor.mjs help auth
node .\dist\agy-supervisor.mjs doctor
node .\dist\agy-supervisor.mjs panel
```

`panel` opens a loopback-only, read-only status page (`http://127.0.0.1`) with a random local port and an access token. It reads bounded Supervisor inspect/ping data, auto-refreshes with GET, and can copy a sanitized no-side-effect handoff JSON. It cannot send prompts, resume, cancel, close, edit model/effort/permissions, or run login/updater/AGY commands. Resume remains outside the panel via MCP tools plus `SEND_TO_AGY` confirmation. Whether a Codex host exposes an installed plugin as a shell command is host-specific and is not claimed here.

`doctor` is credential-free: it checks the local executable path, version, hash, Authenticode signature, required `--help` capabilities, and reports only whether non-secret HTTP/HTTPS proxy routing is available. It never exposes proxy values, sends a prompt, or invokes `agy models`, `agy update`, or login.

MCP tools:

- `agy_help` — concise help for `overview`, `session`, `version`, `auth`, `model`, `cancel`, `doctor`, or `panel`.
- `agy_doctor` — run the no-prompt runtime compatibility gate.
- `agy_session_start` — asynchronously start a new or resumed turn after explicit `SEND_TO_AGY` confirmation.
- `agy_session_inspect` — read bounded state, optionally waiting for a change.
- `agy_session_control` — cancel the current owned turn or close an idle session after explicit confirmation.

Supply a stable `requestId` to `agy_session_start` whenever a frontend may retry after a timeout; this binds deduplication to the full session, workspace, prompt hash, model, and effort intent.

## Development

```powershell
npm test
npm run build
node .\dist\agy-supervisor.mjs --help
```

Tests use fake child processes and temporary state. They do not run the installed AGY binary or inspect Windows credentials. Passing fake-child tests is a source/test fact, not evidence of real AGY runtime or authentication acceptance.
