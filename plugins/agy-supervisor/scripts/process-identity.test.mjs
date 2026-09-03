import assert from "node:assert/strict";
import test from "node:test";
import { inspectProcessIdentity, processIsAlive } from "./process-identity.mjs";

test("dead and invalid process IDs are reported without probing WMI", async () => {
  assert.equal(processIsAlive(-1), false);
  const result = await inspectProcessIdentity(-1, {
    platform: "win32",
    execFileImpl: async () => {
      throw new Error("must not run");
    },
  });
  assert.deepEqual(result, { alive: false, fingerprint: null });
});

test("Windows identity exposes only bounded proof fields and hashes command line", async () => {
  const result = await inspectProcessIdentity(process.pid, {
    platform: "win32",
    execFileImpl: async () => JSON.stringify({
      Name: "agy.exe",
      ExecutablePath: "C:\\safe\\agy.exe",
      CreatedAt: "2026-09-03T00:00:00.000Z",
      CommandLine: "agy --model safe",
    }),
  });
  assert.equal(result.alive, true);
  assert.equal(result.executablePath, "C:\\safe\\agy.exe");
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal("commandLine" in result, false);
});
