import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import {
  SUPPORTED_AGY_SHA256,
  SUPPORTED_AGY_VERSION,
} from "./agy-runtime.mjs";

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function unavailable(failureKind, observedSha256 = null) {
  return {
    ok: false,
    status: "UNAVAILABLE",
    failureKind,
    expectedVersion: SUPPORTED_AGY_VERSION,
    expectedSha256: SUPPORTED_AGY_SHA256,
    observedSha256,
  };
}

export async function prepareManagedRuntime({
  sourcePath,
  stateDir,
  verifier,
  hashFile = sha256,
  copyFileImpl = copyFile,
}) {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || typeof stateDir !== "string" || !path.isAbsolute(stateDir)) {
    return unavailable("RUNTIME_MISSING");
  }
  if (!verifier || typeof verifier.verify !== "function") return unavailable("RUNTIME_GATE_UNAVAILABLE");

  let sourceInfo;
  let sourceHash;
  try {
    sourceInfo = await stat(sourcePath);
    if (!sourceInfo.isFile()) return unavailable("RUNTIME_MISSING");
    sourceHash = await hashFile(sourcePath);
  } catch {
    return unavailable("RUNTIME_MISSING");
  }
  if (sourceHash !== SUPPORTED_AGY_SHA256) return unavailable("HASH_MISMATCH", sourceHash);

  const runtimeDir = path.join(stateDir, "runtime");
  const snapshotPath = path.join(runtimeDir, `agy-${SUPPORTED_AGY_VERSION}-${SUPPORTED_AGY_SHA256}.exe`);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  let snapshotReady = false;
  try {
    snapshotReady = (await hashFile(snapshotPath)) === SUPPORTED_AGY_SHA256;
  } catch {
    snapshotReady = false;
  }
  if (!snapshotReady) {
    try {
      const existing = await stat(snapshotPath);
      if (existing.isFile()) return unavailable("RUNTIME_SNAPSHOT_TAMPERED", await hashFile(snapshotPath).catch(() => null));
    } catch (error) {
      if (error?.code !== "ENOENT") return unavailable("RUNTIME_SNAPSHOT_UNAVAILABLE");
    }
    const temporaryPath = path.join(runtimeDir, `.agy-${randomUUID()}.tmp`);
    try {
      await copyFileImpl(sourcePath, temporaryPath);
      const copiedHash = await hashFile(temporaryPath);
      if (copiedHash !== SUPPORTED_AGY_SHA256) return unavailable("RUNTIME_CHANGED_DURING_COPY", copiedHash);
      await chmod(temporaryPath, 0o500).catch(() => {});
      try {
        await rename(temporaryPath, snapshotPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (await hashFile(snapshotPath) !== SUPPORTED_AGY_SHA256) return unavailable("RUNTIME_SNAPSHOT_TAMPERED");
      }
      snapshotReady = true;
    } catch {
      return unavailable("RUNTIME_SNAPSHOT_UNAVAILABLE");
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }

  const report = await verifier.verify({ agyPath: snapshotPath });
  if (!report?.ok) return report || unavailable("RUNTIME_GATE_FAILED");
  return {
    ...report,
    managedRuntime: true,
    managedRuntimePath: snapshotPath,
    executionPath: sourcePath,
    executionMode: "verified-installed-binary",
    sourceSha256: sourceHash,
  };
}
