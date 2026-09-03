import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATE_SCHEMA_VERSION,
  StateStore,
  canonicalWorkspace,
  createEmptyState,
  hashPrompt,
  recoverInterruptedState,
  validatePersistableState,
} from "./state-store.mjs";

test("state store persists serialized updates through an atomic replacement", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agy-state-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = join(root, "nested", "state.json");
  const store = new StateStore(filePath);

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.update((state) => {
        state.runs[`run-${index}`] = { runId: `run-${index}`, status: "completed" };
      }),
    ),
  );

  const persisted = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(persisted.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(Object.keys(persisted.runs).length, 12);
  assert.deepEqual(readdirSync(join(root, "nested")).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(Object.keys((await store.snapshot()).runs).length, 12);
});

test("missing state starts empty while corrupt and unknown schemas fail closed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agy-state-load-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missingPath = join(root, "missing", "state.json");
  assert.deepEqual(await new StateStore(missingPath).load(), createEmptyState());

  const corruptPath = join(root, "corrupt.json");
  writeFileSync(corruptPath, "{not json", "utf8");
  await assert.rejects(new StateStore(corruptPath).load(), /corrupt/i);

  const unknownPath = join(root, "unknown.json");
  writeFileSync(unknownPath, JSON.stringify({ ...createEmptyState(), schemaVersion: 2 }), "utf8");
  await assert.rejects(new StateStore(unknownPath).load(), /unsupported state schema/i);
});

test("state validation rejects secrets, raw content, and oversized metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agy-state-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new StateStore(join(root, "state.json"));

  for (const forbiddenKey of ["prompt", "Response", "stdout", "stderr", "argv", "environment", "env", "token", "secret", "password", "credential", "oauth", "authCode"]) {
    const state = createEmptyState();
    state.runs.example = { runId: "example", [forbiddenKey]: "must not persist" };
    assert.throws(() => validatePersistableState(state), /forbidden key/i);
  }

  const oversized = createEmptyState();
  oversized.sessions.example = { sessionId: "example", status: "x".repeat(257) };
  assert.throws(() => validatePersistableState(oversized), /exceeds/i);

  await assert.rejects(
    store.update((state) => {
      state.runs.example = { runId: "example", prompt: "not persisted" };
    }),
    /forbidden key/i,
  );
  assert.deepEqual(await store.snapshot(), createEmptyState());
});

test("restart recovery leaves confirmed session configuration but clears transient execution state", () => {
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    sessions: {
      session: {
        sessionId: "session",
        conversationId: "opaque-conversation-id",
        model: "model-a",
        effort: "high",
        activeTurnId: "turn-1",
        childPid: 1234,
      },
    },
    runs: {
      first: { runId: "first", phase: "running", activeTurnId: "turn-1", pid: 4321 },
      second: { runId: "second", status: "cancel_requested", reservationId: "reservation-1" },
    },
    reservations: { workspace: { sessionId: "session" } },
  };

  const recovered = recoverInterruptedState(state, "2026-09-03T00:00:00.000Z");
  assert.equal(recovered.runs.first.phase, "unknown_after_restart");
  assert.equal(recovered.runs.second.status, "unknown_after_restart");
  assert.equal(recovered.runs.first.recoveredAt, "2026-09-03T00:00:00.000Z");
  assert.deepEqual(recovered.reservations, {});
  assert.equal("activeTurnId" in recovered.sessions.session, false);
  assert.equal("childPid" in recovered.sessions.session, false);
  assert.equal("pid" in recovered.runs.first, false);
  assert.equal("reservationId" in recovered.runs.second, false);
  assert.equal(recovered.sessions.session.conversationId, "opaque-conversation-id");
  assert.equal(recovered.sessions.session.model, "model-a");
  assert.equal(state.runs.first.phase, "running");
});

test("workspace keys canonicalize and prompt metadata keeps only a hash and byte count", () => {
  assert.equal(canonicalWorkspace("C:\\Work\\Demo\\..\\Project"), "c:\\work\\project");
  const prompt = "hé🙂";
  const metadata = hashPrompt(prompt);
  assert.deepEqual(metadata, {
    sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    bytes: Buffer.byteLength(prompt, "utf8"),
  });
  assert.equal("prompt" in metadata, false);
});
