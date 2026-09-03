import { execFile } from "node:child_process";
import { access, chmod, mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, "dist");
const next = path.join(root, `.dist-next-${process.pid}`);
const backup = path.join(root, `.dist-previous-${process.pid}`);
const execFileAsync = promisify(execFile);

await rm(next, { recursive: true, force: true });
await rm(backup, { recursive: true, force: true });
await mkdir(next, { recursive: true });

await build({
  entryPoints: {
    "agy-supervisor": path.join(root, "scripts", "server.mjs"),
    "agy-supervisor-daemon": path.join(root, "scripts", "supervisor-daemon.mjs"),
  },
  outdir: next,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  sourcemap: false,
  legalComments: "none",
});

await Promise.all([
  chmod(path.join(next, "agy-supervisor.mjs"), 0o755),
  chmod(path.join(next, "agy-supervisor-daemon.mjs"), 0o755),
  execFileAsync(process.execPath, ["--check", path.join(next, "agy-supervisor.mjs")]),
  execFileAsync(process.execPath, ["--check", path.join(next, "agy-supervisor-daemon.mjs")]),
]);

let hadPrevious = false;
try {
  try {
    await access(outdir);
    await rename(outdir, backup);
    hadPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(next, outdir);
  if (hadPrevious) await rm(backup, { recursive: true, force: true });
} catch (error) {
  if (hadPrevious) {
    await rm(outdir, { recursive: true, force: true });
    await rename(backup, outdir);
  }
  throw error;
} finally {
  await rm(next, { recursive: true, force: true });
}
