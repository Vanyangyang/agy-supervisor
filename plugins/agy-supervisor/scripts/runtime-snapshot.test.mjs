import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareManagedRuntime } from "./runtime-snapshot.mjs";
import { SUPPORTED_AGY_SHA256 } from "./agy-runtime.mjs";

test("managed runtime never executes a copied file whose hash is not pinned", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "agy.exe");
  await writeFile(sourcePath, "not the approved binary", "utf8");
  let verifyCalls = 0;
  const report = await prepareManagedRuntime({
    sourcePath,
    stateDir: path.join(root, "state"),
    verifier: { verify: async () => { verifyCalls += 1; return { ok: true }; } },
  });
  assert.equal(report.ok, false);
  assert.equal(report.failureKind, "HASH_MISMATCH");
  assert.equal(verifyCalls, 0);
});

test("approved bytes are copied to a private content-addressed path before verification", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-snapshot-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "agy.exe");
  await writeFile(sourcePath, "approved fixture", "utf8");
  let verifiedPath;
  const report = await prepareManagedRuntime({
    sourcePath,
    stateDir: path.join(root, "state"),
    hashFile: async (filePath) => {
      await stat(filePath);
      return SUPPORTED_AGY_SHA256;
    },
    verifier: {
      verify: async ({ agyPath }) => {
        verifiedPath = agyPath;
        assert.equal(await readFile(agyPath, "utf8"), "approved fixture");
        return { ok: true, status: "READY", version: "1.1.25", sha256: SUPPORTED_AGY_SHA256 };
      },
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.managedRuntime, true);
  assert.equal(report.managedRuntimePath, verifiedPath);
  assert.equal(report.executionPath, sourcePath);
  assert.equal(report.executionMode, "verified-installed-binary");
  assert.match(verifiedPath, /agy-1\.1\.25-[A-F0-9]{64}\.exe$/u);
});
