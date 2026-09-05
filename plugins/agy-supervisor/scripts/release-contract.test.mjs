import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isCompatibleManifestVersion(manifestVersion, packageVersion) {
  if (manifestVersion === packageVersion) return true;
  return new RegExp(
    `^${escapeRegex(packageVersion)}\\+codex\\.[a-z0-9]+(?:-[a-z0-9]+)*$`,
    "u",
  ).test(manifestVersion);
}

test("package, lockfile, manifest, and runtime entries stay aligned", async () => {
  const [packageJson, lockfile, manifest, serverSource, transportSource] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
    readJson(path.join(".codex-plugin", "plugin.json")),
    readFile(path.join(root, "scripts", "server.mjs"), "utf8"),
    readFile(path.join(root, "scripts", "supervisor-transport.mjs"), "utf8"),
  ]);
  const packageEntry = packageJson.bin?.[packageJson.name];
  const lockRoot = lockfile.packages?.[""];
  const mcpEntry = manifest.mcpServers?.[manifest.name];
  const versionLiteral = `["']${escapeRegex(packageJson.version)}["']`;

  assert.equal(packageJson.version, lockfile.version);
  assert.equal(packageJson.version, lockRoot?.version);
  assert.ok(
    isCompatibleManifestVersion(manifest.version, packageJson.version),
    `manifest version must be ${packageJson.version} or ${packageJson.version}+codex.<lowercase-hyphenated-cachebuster>`,
  );
  assert.equal(isCompatibleManifestVersion(`${packageJson.version}+codex.local-20260905`, packageJson.version), true);
  assert.equal(isCompatibleManifestVersion(`${packageJson.version}+other.local-20260905`, packageJson.version), false);
  assert.equal(isCompatibleManifestVersion(`${packageJson.version}+codex.invalid_suffix`, packageJson.version), false);
  assert.equal(isCompatibleManifestVersion("0.0.0+codex.local-20260905", packageJson.version), false);
  assert.match(serverSource, new RegExp(`const VERSION = ${versionLiteral};`, "u"));
  assert.match(transportSource, new RegExp(`export const SUPERVISOR_RUNTIME_VERSION = ${versionLiteral};`, "u"));
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
