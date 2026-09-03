import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SupervisorClient } from "./supervisor-client.mjs";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_RUNTIME_VERSION,
} from "./supervisor-transport.mjs";

export const PANEL_SCHEMA_VERSION = 1;

const FORBIDDEN_KEY = /(?:prompt|response|^result$|resultbody|argv|environment|^env$|stdout|stderr|hmac|token|secret|password|credential|oauth|cookie|proxy|pipe|login|authcode|authorization)/i;

function normalizedKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isLoopbackAddress(address) {
  const value = String(address || "").replace(/^::ffff:/i, "").trim();
  return value === "127.0.0.1" || value === "::1" || value === "localhost" || value === "0:0:0:0:0:0:0:1";
}

export function isAllowedHost(hostHeader, port) {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw) return false;
  const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  const allowedWithPort = new Set();
  if (Number.isInteger(port)) {
    for (const host of allowedHosts) {
      allowedWithPort.add(`${host}:${port}`);
    }
  }
  return allowedHosts.has(raw) || allowedWithPort.has(raw);
}

export function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(a, b);
}

function isForbiddenKey(key) {
  const normalized = normalizedKey(key);
  if (!normalized) return false;
  if (normalized === "result" || normalized === "resultbody" || normalized === "resulttext") return true;
  return FORBIDDEN_KEY.test(normalized) || FORBIDDEN_KEY.test(String(key));
}

export function containsForbiddenFields(value, path = "root") {
  const hits = [];
  const visit = (node, location) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (isForbiddenKey(key)) hits.push(`${location}.${key}`);
      visit(child, `${location}.${key}`);
    }
  };
  visit(value, path);
  return hits;
}

export function boundedErrorKind(value) {
  if (typeof value !== "string" || !value) return null;
  return /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value) ? value : "ERROR";
}

export function publicLifecycle(status) {
  const value = String(status || "").toLowerCase();
  if (!value) return "empty";
  if (["starting", "running", "cancel_requested"].includes(value)) return "running";
  if (["needs_attention", "unknown_after_restart", "update_pending_compatibility"].includes(value)) return "uncertain";
  if (value === "closed") return "closed";
  if (value === "idle") return "idle";
  return value.slice(0, 64);
}

export function sanitizeSession(session) {
  if (!session || typeof session !== "object") return null;
  return {
    sessionId: session.sessionId ?? null,
    conversationId: session.conversationId ?? null,
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    effort: session.effort ?? null,
    effortStatus: session.effortStatus ?? null,
    permissionMode: session.permissionMode ?? null,
    status: session.status ?? null,
    lifecycle: publicLifecycle(session.status),
    activeRunId: session.activeRunId ?? null,
    runtimeVersion: session.runtimeVersion ?? null,
    runtimeSha256: session.runtimeSha256 ?? null,
    runtimeSignatureStatus: session.runtimeSignatureStatus ?? null,
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
    closedAt: session.closedAt ?? null,
  };
}

export function sanitizeRun(run) {
  if (!run || typeof run !== "object") return null;
  return {
    runId: run.runId ?? null,
    sessionId: run.sessionId ?? null,
    requestId: run.requestId ?? null,
    status: run.status ?? null,
    lifecycle: publicLifecycle(run.status),
    phase: typeof run.phase === "string" ? run.phase.slice(0, 64) : null,
    resultAvailable: Boolean(run.resultAvailable),
    errorKind: boundedErrorKind(run.errorKind || run.failureKind),
    startedAt: run.startedAt ?? null,
    updatedAt: run.updatedAt ?? null,
    completedAt: run.completedAt ?? null,
  };
}

export function buildHandoffPayload({
  generatedAt,
  supervisorVersion,
  epochId,
  revision,
  session,
  run,
} = {}) {
  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    supervisorVersion: supervisorVersion || SUPERVISOR_RUNTIME_VERSION,
    epochId: epochId ?? null,
    revision: Number.isInteger(revision) ? revision : null,
    sessionId: session?.sessionId ?? null,
    conversationId: session?.conversationId ?? null,
    cwd: session?.cwd ?? null,
    model: session?.model ?? null,
    effort: session?.effort ?? null,
    effortStatus: session?.effortStatus ?? null,
    permissionMode: session?.permissionMode ?? null,
    sessionStatus: session?.status ?? null,
    runStatus: run?.status ?? null,
    runId: run?.runId ?? null,
    requestId: run?.requestId ?? null,
    startedAt: run?.startedAt ?? session?.createdAt ?? null,
    updatedAt: run?.updatedAt ?? session?.updatedAt ?? null,
  };
}

export async function readPanelState(client, {
  sessionId,
  now = () => new Date().toISOString(),
  supervisorVersion = SUPERVISOR_RUNTIME_VERSION,
} = {}) {
  const generatedAt = now();
  const offline = (errorKind) => ({
    daemonOnline: false,
    errorKind: boundedErrorKind(errorKind) || "DAEMON_OFFLINE",
    generatedAt,
    supervisorVersion,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    epochId: null,
    revision: null,
    sessions: [],
    selectedSession: null,
    selectedRun: null,
    handoff: buildHandoffPayload({ generatedAt, supervisorVersion }),
  });
  if (!client || typeof client.inspect !== "function") return offline("DAEMON_OFFLINE");
  try {
    const ping = typeof client.ping === "function" ? await client.ping() : { ready: true };
    const inspect = await client.inspect(sessionId ? { sessionId } : {});
    const sessions = Array.isArray(inspect?.sessions)
      ? inspect.sessions.map(sanitizeSession).filter(Boolean)
      : (inspect?.session ? [sanitizeSession(inspect.session)].filter(Boolean) : []);
    const selectedSession = sanitizeSession(inspect?.session) || (sessionId
      ? sessions.find((item) => item.sessionId === sessionId) || null
      : sessions[0] || null);
    const selectedRun = sanitizeRun(inspect?.run);
    const epochId = inspect?.epochId ?? ping?.epochId ?? null;
    const revision = Number.isInteger(inspect?.revision) ? inspect.revision : null;
    return {
      daemonOnline: ping?.ready !== false,
      errorKind: null,
      generatedAt,
      supervisorVersion: inspect?.daemon?.runtimeVersion || ping?.runtimeVersion || supervisorVersion,
      protocolVersion: inspect?.daemon?.protocolVersion || ping?.protocolVersion || SUPERVISOR_PROTOCOL_VERSION,
      epochId,
      revision,
      sessions,
      selectedSession,
      selectedRun,
      handoff: buildHandoffPayload({
        generatedAt,
        supervisorVersion: inspect?.daemon?.runtimeVersion || supervisorVersion,
        epochId,
        revision,
        session: selectedSession,
        run: selectedRun,
      }),
    };
  } catch (error) {
    return offline(error?.kind || error?.code || "DAEMON_OFFLINE");
  }
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

export function renderPanelPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AGY Supervisor status</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<style>
:root { color-scheme: dark light; --bg:#111; --fg:#f4f4f0; --muted:#b7b7b0; --card:#1c1c1c; --accent:#8cb4ff; --ok:#8fd18f; --warn:#e0c36a; --bad:#ef8a8a; }
html,body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.45 system-ui, Segoe UI, sans-serif; }
.skip { position:absolute; left:-999px; }
.skip:focus { left:1rem; top:1rem; background:var(--card); padding:.5rem; }
header,main,footer { max-width:72rem; margin:0 auto; padding:1rem 1.25rem; }
h1,h2 { line-height:1.2; }
.banner { color:var(--muted); max-width:50rem; }
.grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(16rem,1fr)); }
section { background:var(--card); border-radius:12px; padding:1rem; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:.25rem 1rem; margin:0; }
dt { color:var(--muted); }
button,select { font:inherit; }
button { background:var(--accent); color:#111; border:0; border-radius:8px; padding:.45rem .8rem; cursor:pointer; }
button:focus,select:focus,input:focus { outline:2px solid var(--accent); outline-offset:2px; }
.row { display:flex; gap:.75rem; flex-wrap:wrap; align-items:center; }
.status-ok { color:var(--ok); }
.status-warn { color:var(--warn); }
.status-bad { color:var(--bad); }
pre { overflow:auto; background:#00000055; padding:.75rem; border-radius:8px; white-space:pre-wrap; }
[hidden] { display:none !important; }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to status</a>
<header>
  <h1>AGY Supervisor status</h1>
  <p class="banner">Read-only local panel. This is not an Antigravity chat client and cannot send, resume, cancel, close, edit model/effort/permissions, or run sign-in/updater commands. Continue/resume remains outside this page via MCP tools with an explicit confirmation.</p>
</header>
<main id="main">
  <section aria-labelledby="daemon-heading">
    <h2 id="daemon-heading">Daemon</h2>
    <p id="offline-state" class="status-bad" hidden>Supervisor daemon is offline. This panel does not start it.</p>
    <p id="error-state" class="status-bad" hidden></p>
    <dl>
      <dt>Online</dt><dd id="daemon-online">unknown</dd>
      <dt>Epoch</dt><dd id="daemon-epoch">-</dd>
      <dt>Revision</dt><dd id="daemon-revision">-</dd>
      <dt>Supervisor</dt><dd id="daemon-version">-</dd>
      <dt>Protocol</dt><dd id="daemon-protocol">-</dd>
    </dl>
  </section>
  <div class="grid">
    <section aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Sessions</h2>
      <p id="empty-state" hidden>No sessions are recorded.</p>
      <label for="session-select">Selected session</label>
      <select id="session-select" aria-describedby="sessions-heading"></select>
    </section>
    <section aria-labelledby="detail-heading">
      <h2 id="detail-heading">Selected session</h2>
      <dl id="session-fields"></dl>
    </section>
  </div>
  <section aria-labelledby="handoff-heading">
    <h2 id="handoff-heading">Handoff JSON</h2>
    <p>Sanitized no-side-effect snapshot. Copy does not take over a session and omits prompts, responses, secrets, and environment.</p>
    <pre id="handoff-preview" aria-live="polite">{}</pre>
    <div class="row">
      <button type="button" id="copy-handoff">Copy handoff JSON</button>
      <span id="copy-status" role="status"></span>
    </div>
  </section>
</main>
<footer>
  <div class="row">
    <button type="button" id="refresh">Refresh</button>
    <label><input type="checkbox" id="auto-refresh" checked> Auto-refresh (GET only)</label>
    <span id="status-live" role="status" aria-live="polite"></span>
  </div>
</footer>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const sessionSelect = document.getElementById("session-select");
const fields = document.getElementById("session-fields");
let selectedId = "";
let timer = null;
function tokenQuery(extra) {
  const params = new URLSearchParams(extra || {});
  params.set("token", token);
  return params.toString();
}
function setText(id, value, className) {
  const node = document.getElementById(id);
  node.textContent = value == null || value === "" ? "-" : String(value);
  node.className = className || "";
}
function renderFields(pairs) {
  fields.replaceChildren();
  for (const [label, value] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value == null || value === "" ? "-" : String(value);
    fields.append(dt, dd);
  }
}
async function load() {
  const query = tokenQuery(selectedId ? { sessionId: selectedId } : {});
  const response = await fetch("/api/status?" + query, { method: "GET", headers: { Accept: "application/json" } });
  const data = await response.json();
  setText("daemon-online", data.daemonOnline ? "yes" : "no", data.daemonOnline ? "status-ok" : "status-bad");
  setText("daemon-epoch", data.epochId);
  setText("daemon-revision", data.revision);
  setText("daemon-version", data.supervisorVersion);
  setText("daemon-protocol", data.protocolVersion);
  document.getElementById("offline-state").hidden = data.daemonOnline !== false || Boolean(data.daemonOnline);
  document.getElementById("offline-state").hidden = data.daemonOnline === true;
  const error = document.getElementById("error-state");
  error.hidden = !data.errorKind;
  error.textContent = data.errorKind ? ("Error: " + data.errorKind) : "";
  const sessions = data.sessions || [];
  document.getElementById("empty-state").hidden = !(data.daemonOnline && sessions.length === 0);
  const current = sessionSelect.value;
  sessionSelect.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = sessions.length ? "Select a session" : "No sessions";
  sessionSelect.append(blank);
  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.sessionId;
    option.textContent = session.sessionId + " (" + (session.lifecycle || session.status || "unknown") + ")";
    sessionSelect.append(option);
  }
  selectedId = data.selectedSession?.sessionId || current || "";
  sessionSelect.value = selectedId;
  const session = data.selectedSession;
  const run = data.selectedRun;
  renderFields([
    ["sessionId", session?.sessionId],
    ["conversationId", session?.conversationId],
    ["cwd", session?.cwd],
    ["model", session?.model],
    ["effort", session?.effort],
    ["effortStatus", session?.effortStatus],
    ["permissionMode", session?.permissionMode],
    ["lifecycle", session?.lifecycle],
    ["session status", session?.status],
    ["AGY version", session?.runtimeVersion],
    ["hash gate", session?.runtimeSha256],
    ["signature gate", session?.runtimeSignatureStatus],
    ["activeRunId", session?.activeRunId],
    ["requestId", run?.requestId],
    ["run status", run?.status],
    ["run lifecycle", run?.lifecycle],
    ["result available", run ? String(Boolean(run.resultAvailable)) : null],
    ["startedAt", run?.startedAt || session?.createdAt],
    ["updatedAt", run?.updatedAt || session?.updatedAt],
    ["last error", run?.errorKind],
  ]);
  document.getElementById("handoff-preview").textContent = JSON.stringify(data.handoff || {}, null, 2);
  document.getElementById("status-live").textContent = data.daemonOnline ? "Status refreshed." : "Daemon offline.";
}
document.getElementById("refresh").addEventListener("click", () => { load().catch(() => {}); });
sessionSelect.addEventListener("change", () => { selectedId = sessionSelect.value; load().catch(() => {}); });
document.getElementById("copy-handoff").addEventListener("click", async () => {
  const text = document.getElementById("handoff-preview").textContent;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById("copy-status").textContent = "Copied.";
  } catch {
    document.getElementById("copy-status").textContent = "Copy failed; select the JSON above.";
  }
});
function syncTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (document.getElementById("auto-refresh").checked) timer = setInterval(() => { load().catch(() => {}); }, 4000);
}
document.getElementById("auto-refresh").addEventListener("change", syncTimer);
load().catch(() => { document.getElementById("status-live").textContent = "Unable to load status."; });
syncTimer();
</script>
</body>
</html>`;
}

function requestUrl(req) {
  return new URL(req.url || "/", "http://127.0.0.1");
}

function presentedToken(req, url) {
  const header = String(req.headers.authorization || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return url.searchParams.get("token") || bearer || "";
}

function send(res, status, body, headers = {}) {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(payload.length),
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, value) {
  send(res, status, `${JSON.stringify(value)}\n`, { "Content-Type": "application/json; charset=utf-8" });
}

export async function createPanelServer({
  client,
  host = "127.0.0.1",
  port = 0,
  accessToken,
  now = () => new Date().toISOString(),
  supervisorVersion = SUPERVISOR_RUNTIME_VERSION,
} = {}) {
  if (host !== "127.0.0.1") {
    throw new Error("panel_bind_loopback_only");
  }
  const token = accessToken || randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    const localPort = server.address()?.port;
    if (!isLoopbackAddress(req.socket.remoteAddress) || !isAllowedHost(req.headers.host, localPort)) {
      send(res, 403, "forbidden\n", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "method not allowed\n", { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    let url;
    try {
      url = requestUrl(req);
    } catch {
      send(res, 400, "bad request\n", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    if (!timingSafeEqualText(presentedToken(req, url), token)) {
      send(res, 401, "unauthorized\n", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = renderPanelPage();
      send(res, 200, req.method === "HEAD" ? "" : html, { "Content-Type": "text/html; charset=utf-8" });
      return;
    }
    if (url.pathname === "/api/status" || url.pathname === "/api/handoff") {
      const sessionId = url.searchParams.get("sessionId") || undefined;
      const state = await readPanelState(client, { sessionId, now, supervisorVersion });
      const payload = url.pathname === "/api/handoff" ? state.handoff : state;
      if (req.method === "HEAD") {
        send(res, 200, "", { "Content-Type": "application/json; charset=utf-8" });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }
    send(res, 404, "not found\n", { "Content-Type": "text/plain; charset=utf-8" });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const boundPort = address.port;
  const url = `http://127.0.0.1:${boundPort}/?token=${token}`;
  return {
    server,
    host,
    port: boundPort,
    token,
    url,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function startPanelFromCli({
  client = new SupervisorClient({ timeoutMs: 1500 }),
  stdout = process.stdout,
} = {}) {
  const panel = await createPanelServer({ client });
  stdout.write(`AGY Supervisor panel (read-only)\nListening on ${panel.url}\nLoopback only; this page cannot send work to AGY.\n`);
  await new Promise((resolve) => {
    const stop = () => { void panel.close().finally(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return panel;
}