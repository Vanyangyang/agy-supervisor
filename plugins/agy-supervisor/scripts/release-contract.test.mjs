import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

test("package, lockfile, manifest, and runtime entries stay aligned", async () => {
  const [packageJson, lockfile, manifest] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
    readJson(path.join(".codex-plugin", "plugin.json")),
  ]);
  const packageEntry = packageJson.bin?.[packageJson.name];
  const lockRoot = lockfile.packages?.[""];
  const mcpEntry = manifest.mcpServers?.[manifest.name];

  assert.equal(packageJson.version, lockfile.version);
  assert.equal(packageJson.version, lockRoot?.version);
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageEntry, "dist/agy-supervisor.mjs");
  assert.equal(lockRoot?.bin?.[packageJson.name], packageEntry);
  assert.equal(mcpEntry?.command, "node");
  assert.deepEqual(mcpEntry?.args, ["./dist/agy-supervisor.mjs"]);
  assert.equal(mcpEntry?.cwd, ".");

  await Promise.all([
    access(path.join(root, packageEntry)),
    access(path.join(root, "dist", "agy-supervisor-daemon.mjs")),
  ]);
});
