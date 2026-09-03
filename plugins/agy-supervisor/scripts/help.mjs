export const HELP_TOPICS = Object.freeze({
  overview: `Agy Supervisor is an independent unofficial project and is not affiliated with or endorsed by Google or OpenAI. It runs a persistent daemon with a stream-json stdin session interface. Every managed AGY session explicitly uses --dangerously-skip-permissions, so all AGY tool calls are auto-approved inside the requested workspace and sandbox boundary.

Common MCP tools: agy_help, agy_doctor, agy_session_start, agy_session_inspect, agy_session_control.`,

  session: `Sessions are owned by the persistent daemon and use stream-json over stdin. Pass a stable requestId when retry safety matters. After a daemon restart, resume only with the exact confirmed conversation ID; it is opaque and is never guessed or reconstructed. An interrupted turn must be explicitly acknowledged with agy_session_control before new work can continue.`,

  version: `The supported AGY runtime is 1.1.25 and must pass the exact hash/signature gate. The updater is disabled only in the managed child, not as a general machine-wide setting. A Supervisor protocol or runtime mismatch fails closed and requires a controlled daemon restart. Hash, signature, and version gates are not auto-bypassed; install a reviewed Supervisor release when an upgraded AGY binary is blocked.`,

  auth: `AGY reads the current user's existing profile and Windows Credential Manager. Before each new child, the wrapper refreshes its credential-free environment and fills missing HTTP/HTTPS proxy settings from the current Windows user's enabled proxy configuration. Managed headless children run with CI=true so authentication failure is reported instead of starting an interactive login. The wrapper never reads, copies, or stores credentials; repair authentication only in an interactive terminal running AGY. Windows daemon launch uses PowerShell -ExecutionPolicy Bypass only for ordinary-user detached process launch, not elevation.`,

  model: `Model and effort are fixed for the lifetime of one session. The effective effort value is ACCEPTED_NOT_ATTESTED: the CLI accepted the requested value. This is not an attested thinking-strength measurement from AGY.`,

  cancel: `Cancel targets the exact owned child only. Work with an uncertain outcome is never replayed automatically, so a restart cannot duplicate a prompt. Use acknowledge_uncertain with the exact run ID only after reviewing that uncertainty.`,

  doctor: `Doctor is credential-free. It reports only whether non-secret HTTP/HTTPS proxy routing is available; it never exposes proxy values and never runs prompts, models, update, or login operations.`,
});

const TOPIC_NAMES = Object.freeze(Object.keys(HELP_TOPICS));

export function getHelp(topic = "overview") {
  const normalized = typeof topic === "string" ? topic.trim().toLowerCase() : "";
  if (Object.hasOwn(HELP_TOPICS, normalized)) return HELP_TOPICS[normalized];
  return `Unknown help topic: ${String(topic)}. Available topics: ${TOPIC_NAMES.join(", ")}.`;
}

export function renderCliHelp() {
  return [
    "AGY Supervisor",
    "Usage: agy-supervisor --help | help <topic> | doctor",
    "",
    `Topics: ${TOPIC_NAMES.join(", ")}`,
    "MCP tools: agy_help, agy_doctor, agy_session_start, agy_session_inspect, agy_session_control",
    "",
    ...TOPIC_NAMES.flatMap((topic) => [`[${topic}]`, HELP_TOPICS[topic], ""]),
  ].join("\n").trimEnd();
}
