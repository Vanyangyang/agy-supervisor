#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRuntimeVerifier,
  defaultAgyPath,
  readWindowsUserProxyEnvironment,
} from "./agy-runtime.mjs";
import { getHelp, HELP_TOPICS, renderCliHelp } from "./help.mjs";
import { startPanelFromCli } from "./panel.mjs";
import { prepareManagedRuntime } from "./runtime-snapshot.mjs";
import { ensureSupervisorRunning } from "./supervisor-client.mjs";
import { getSupervisorPaths } from "./supervisor-transport.mjs";

const VERSION = "0.3.0";
const here = fileURLToPath(import.meta.url);
const built = path.basename(here) === "agy-supervisor.mjs";
const daemonEntry = fileURLToPath(new URL(built ? "./agy-supervisor-daemon.mjs" : "./supervisor-daemon.mjs", import.meta.url));

function fixedError(error) {
  return {
    error: error?.kind || error?.code || "AGY_SUPERVISOR_ERROR",
  };
}

async function runDoctor() {
  try {
    const [runtime, proxy] = await Promise.all([
      prepareManagedRuntime({
        sourcePath: defaultAgyPath(),
        stateDir: getSupervisorPaths().stateDir,
        verifier: createRuntimeVerifier(),
      }),
      readWindowsUserProxyEnvironment(),
    ]);
    return {
      ...runtime,
      authEnvironment: {
        nonInteractive: true,
        httpProxyConfigured: Boolean(proxy.HTTP_PROXY),
        httpsProxyConfigured: Boolean(proxy.HTTPS_PROXY),
      },
    };
  } catch (error) {
    return {
      compatible: false,
      errorKind: error?.kind || error?.code || "RUNTIME_GATE_FAILED",
    };
  }
}

async function handleCli(argv) {
  if (argv.length === 0) return false;
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${renderCliHelp()}\n`);
    return true;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return true;
  }
  if (argv[0] === "help") {
    process.stdout.write(`${getHelp(argv[1] || "overview")}\n`);
    return true;
  }
  if (argv[0] === "doctor") {
    process.stdout.write(`${JSON.stringify(await runDoctor(), null, 2)}\n`);
    return true;
  }
  if (argv[0] === "panel") {
    await startPanelFromCli();
    return true;
  }
  process.stderr.write("Unknown command. Run agy-supervisor --help.\n");
  process.exitCode = 2;
  return true;
}

if (await handleCli(process.argv.slice(2))) {
  // CLI help and doctor intentionally do not start the persistent daemon.
} else {
  let clientPromise;
  const getClient = async () => {
    if (!clientPromise) {
      clientPromise = ensureSupervisorRunning({ daemonEntry, timeoutMs: 15_000 }).then(({ client }) => client);
      clientPromise.catch(() => {
        clientPromise = undefined;
      });
    }
    return clientPromise;
  };

  const server = new McpServer({ name: "agy-supervisor", version: VERSION });

  const result = (value, isError = false) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError,
  });

  const register = (name, definition, handler) => {
    server.registerTool(name, definition, async (args) => {
      try {
        return result(await handler(args));
      } catch (error) {
        return result(fixedError(error), true);
      }
    });
  };

  register("agy_help", {
    description: "Show concise AGY Supervisor usage and safety help without starting AGY, testing authentication, or changing local state.",
    inputSchema: {
      topic: z.enum(Object.keys(HELP_TOPICS)).optional().default("overview"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, ({ topic }) => ({ topic, text: getHelp(topic) }));

  register("agy_doctor", {
    description: "Credential-free compatibility check for the pinned AGY executable, version, SHA-256, Google signature, required headless flags, and non-secret proxy availability. Never runs a prompt, login, updater, or model listing.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, () => runDoctor());

  register("agy_session_start", {
    description: "Start one asynchronous turn in a new or exact existing persistent AGY session with --dangerously-skip-permissions. Every AGY tool call is auto-approved; call only for explicitly user-authorized workspace actions. Model and effort are frozen when the session is created.",
    inputSchema: {
      mode: z.enum(["new", "resume"]),
      sessionId: z.string().min(1).max(128).optional().describe("Required for resume; omit for new"),
      cwd: z.string().min(1).max(4096).describe("Absolute existing workspace directory"),
      prompt: z.string().min(1).max(48_000)
        .refine((value) => Buffer.byteLength(value, "utf8") <= 48_000, "Prompt exceeds 48000 UTF-8 bytes")
        .describe("Turn instruction; sent through stdin and never persisted"),
      requestId: z.string().min(1).max(128).optional().describe("Optional idempotency key"),
      model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).optional().describe("New-session model; defaults to gemini-3.8-flash"),
      effort: z.enum(["low", "medium", "high"]).optional().describe("New-session effort; defaults to high"),
      confirmation: z.literal("SEND_TO_AGY"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (args) => (await getClient()).startTurn(args));

  register("agy_session_inspect", {
    description: "Inspect bounded durable AGY session/run metadata and, while the same daemon is alive, the in-memory terminal response. Optionally wait for a revision change; timeout never cancels work.",
    inputSchema: {
      sessionId: z.string().min(1).max(128).optional(),
      runId: z.string().min(1).max(128).optional(),
      afterRevision: z.number().int().nonnegative().optional(),
      waitMs: z.number().int().min(0).max(25_000).optional().default(0),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async (args) => (await getClient()).inspect(args));

  register("agy_session_control", {
    description: "Cancel the exact active turn owned by this daemon, acknowledge one reviewed uncertain run after its recorded process is gone, or gracefully close an idle session. It never kills or adopts an unverified PID and never replays uncertain work.",
    inputSchema: {
      action: z.enum(["cancel_turn", "acknowledge_uncertain", "close_session"]),
      sessionId: z.string().min(1).max(128),
      runId: z.string().min(1).max(128).optional().describe("Required for cancel_turn and acknowledge_uncertain"),
      confirmation: z.literal("CONTROL_AGY_SESSION"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (args) => (await getClient()).control(args));

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    if (clientPromise) void clientPromise.then((client) => client.detach()).catch(() => {});
  };
  await server.connect(transport);
}
