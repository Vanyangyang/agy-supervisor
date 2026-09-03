import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("checked-in runtime bundles match the current source", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agy-supervisor-dist-parity-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await build({
    entryPoints: {
      "agy-supervisor": path.join(root, "scripts", "server.mjs"),
      "agy-supervisor-daemon": path.join(root, "scripts", "supervisor-daemon.mjs"),
    },
    outdir: temporary,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    sourcemap: false,
    legalComments: "none",
  });
  for (const name of ["agy-supervisor.mjs", "agy-supervisor-daemon.mjs"]) {
    const expected = await readFile(path.join(temporary, name));
    const actual = await readFile(path.join(root, "dist", name));
    assert.equal(sha256(actual), sha256(expected), `${name} is stale; run npm run build`);
  }
});
