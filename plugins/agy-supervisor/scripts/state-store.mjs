import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve, win32 } from "node:path";

export const STATE_SCHEMA_VERSION = 1;

const FORBIDDEN_KEY_PARTS = [
  "prompt",
  "response",
  "stdout",
  "stderr",
  "argv",
  "environment",
  "env",
  "token",
  "secret",
  "password",
  "credential",
  "oauth",
  "authcode",
];

const MAX_OBJECT_KEYS = 1_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_KEY_LENGTH = 256;
const MAX_ID_LENGTH = 512;
const MAX_ENUM_LENGTH = 256;
const MAX_HASH_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_PATH_LENGTH = 4_096;
const WINDOWS_PATH_RE = /^(?:[a-z]:[\\/]|\\\\)/i;

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isHashMetadataKey(key) {
  return key.includes("hash") || key.includes("sha") || key.includes("digest") || key.includes("fingerprint");
}

function isForbiddenKey(key) {
  const normalized = normalizedKey(key);
  return !isHashMetadataKey(normalized) && FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part));
}

function stringLimitForKey(key) {
  const normalized = normalizedKey(key || "");
  if (!normalized) return 0;
  if (isHashMetadataKey(normalized) || normalized.includes("signature")) return MAX_HASH_LENGTH;
  if (/(?:id|ids)$/.test(normalized)) return MAX_ID_LENGTH;
  if (/(?:at|time|timestamp)$/.test(normalized)) return MAX_TIMESTAMP_LENGTH;
  if (/(?:cwd|path|workspace|directory|root)$/.test(normalized) || normalized.includes("workspace")) {
    return MAX_PATH_LENGTH;
  }
  if (
    [
      "model",
      "effort",
      "status",
      "phase",
      "state",
      "errorkind",
      "errorcode",
      "code",
      "version",
      "runtime",
      "runtimemode",
      "lifecycle",
      "lifecyclemode",
      "mode",
      "kind",
      "type",
      "reason",
      "owner",
      "source",
      "target",
      "policy",
      "transport",
    ].some((term) => normalized === term || normalized.endsWith(term))
  ) {
    return MAX_ENUM_LENGTH;
  }
  return 0;
}

function validateValue(value, key, location, seen) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`State contains a non-finite number at ${location}`);
    return;
  }
  if (typeof value === "string") {
    const limit = stringLimitForKey(key);
    if (!limit) throw new TypeError(`State may only persist bounded metadata strings at ${location}`);
    if (value.length > limit) throw new RangeError(`State string exceeds its ${limit}-character limit at ${location}`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`State contains a non-JSON value at ${location}`);
  if (seen.has(value)) throw new TypeError(`State must not contain a cycle at ${location}`);
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new RangeError(`State array is too large at ${location}`);
    for (let index = 0; index < value.length; index += 1) {
      validateValue(value[index], key, `${location}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }

  if (!isPlainObject(value)) throw new TypeError(`State contains a non-plain object at ${location}`);
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) throw new RangeError(`State object is too large at ${location}`);
  for (const [childKey, childValue] of entries) {
    if (childKey.length > MAX_KEY_LENGTH) throw new RangeError(`State key is too long at ${location}`);
    if (isForbiddenKey(childKey)) throw new TypeError(`State must not persist forbidden key: ${childKey}`);
    validateValue(childValue, childKey, `${location}.${childKey}`, seen);
  }
  seen.delete(value);
}

export function createEmptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sessions: {},
    runs: {},
    reservations: {},
  };
}

export function validatePersistableState(state) {
  if (!isPlainObject(state)) throw new TypeError("State must be a plain object");
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported state schema version: ${String(state.schemaVersion)}`);
  }
  validateValue(state, "state", "state", new WeakSet());
  return state;
}

function isTransientPointerKey(key) {
  const normalized = normalizedKey(key);
  return (
    normalized === "pid" ||
    normalized.endsWith("pid") ||
    normalized === "processid" ||
    normalized === "childprocess" ||
    normalized === "process" ||
    /^(?:active|current|pending|inflight)(?:turn|turnid|turnpointer|turnpointerid|run|runid|child|childpid|process|processid)$/.test(normalized)
  );
}

function isReservationKey(key) {
  const normalized = normalizedKey(key);
  return (
    normalized.endsWith("reservation") ||
    normalized.endsWith("reservationid") ||
    normalized.endsWith("reservationkey") ||
    normalized === "reservations" ||
    normalized === "workspacereservations" ||
    normalized === "activereservation" ||
    normalized === "activereservations"
  );
}

function isInterruptedPhase(value) {
  return typeof value === "string" && ["starting", "running", "cancel_requested"].includes(value.toLowerCase());
}

export function recoverInterruptedState(state, nowIso = new Date().toISOString()) {
  if (!isPlainObject(state)) throw new TypeError("State must be a plain object");
  if (typeof nowIso !== "string" || nowIso.length > MAX_TIMESTAMP_LENGTH) {
    throw new TypeError("nowIso must be a bounded timestamp string");
  }

  const recovered = clone(state);
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isPlainObject(node)) return;

    let changedRunState = false;
    for (const key of Object.keys(node)) {
      if (isReservationKey(key)) {
        if (normalizedKey(key).endsWith("reservations")) node[key] = {};
        else delete node[key];
        continue;
      }
      if (isTransientPointerKey(key)) {
        if (Number.isInteger(node[key]) && node[key] > 0) node.recoveryProcessId = node[key];
        delete node[key];
        continue;
      }
      const normalized = normalizedKey(key);
      if ((normalized === "phase" || normalized === "status") && isInterruptedPhase(node[key])) {
        node[key] = "unknown_after_restart";
        changedRunState = true;
        continue;
      }
      visit(node[key]);
    }
    if (changedRunState) node.recoveredAt = nowIso;
  };

  visit(recovered);
  return recovered;
}

export function canonicalWorkspace(pathValue) {
  if (typeof pathValue !== "string" || !pathValue.trim()) {
    throw new TypeError("Workspace path must be a non-empty string");
  }
  const input = pathValue.trim();
  const useWindowsPath = WINDOWS_PATH_RE.test(input);
  const canonical = useWindowsPath
    ? win32.normalize(win32.resolve(input))
    : normalize(resolve(input));
  return useWindowsPath || process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function hashPrompt(prompt) {
  if (typeof prompt !== "string") throw new TypeError("Prompt must be a string");
  return {
    sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    bytes: Buffer.byteLength(prompt, "utf8"),
  };
}

async function writeStateAtomically(filePath, state) {
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await chmod(temporaryPath, 0o600);
    } catch {
      // Windows and some filesystems do not support POSIX permissions.
    }
    await rename(temporaryPath, filePath);
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Best effort only; a successful rename remains the durable write.
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export class StateStore {
  constructor(filePath, { now = () => new Date().toISOString() } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("StateStore requires a file path");
    if (typeof now !== "function") throw new TypeError("StateStore now must be a function");
    this.filePath = resolve(filePath);
    this.now = now;
    this.state = null;
    this.loaded = false;
    this.loadPromise = null;
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = this.enqueue(async () => {
        if (this.loaded) return;
        let parsed;
        try {
          parsed = JSON.parse(await readFile(this.filePath, "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") {
            this.state = createEmptyState();
            this.loaded = true;
            return;
          }
          if (error instanceof SyntaxError) {
            throw new Error(`State file is corrupt: ${this.filePath}`, { cause: error });
          }
          throw error;
        }

        validatePersistableState(parsed);
        const recovered = recoverInterruptedState(parsed, this.now());
        validatePersistableState(recovered);
        if (JSON.stringify(recovered) !== JSON.stringify(parsed)) {
          await writeStateAtomically(this.filePath, recovered);
        }
        this.state = recovered;
        this.loaded = true;
      });
    }
    await this.loadPromise;
    return clone(this.state);
  }

  async snapshot() {
    await this.load();
    await this.queue;
    return clone(this.state);
  }

  async update(mutator) {
    if (typeof mutator !== "function") throw new TypeError("StateStore update requires a mutator function");
    await this.load();
    return this.enqueue(async () => {
      const draft = clone(this.state);
      const result = await mutator(draft);
      const candidate = result === undefined ? draft : result;
      validatePersistableState(candidate);
      await writeStateAtomically(this.filePath, candidate);
      this.state = clone(candidate);
      return clone(this.state);
    });
  }
}
