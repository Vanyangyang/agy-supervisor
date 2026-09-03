import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSafeAgyEnvironment,
  classifyAgyStderr,
  createRuntimeVerifier,
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
  defaultAgyPath,
  parseWindowsProxyServer,
  readWindowsUserProxyEnvironment,
  REQUIRED_AGY_HELP_FLAGS,
  SUPPORTED_AGY_SHA256,
  SUPPORTED_AGY_VERSION,
} from "./agy-runtime.mjs";

const fakePath = "C:\\temporary\\agy.exe";

function fakeStat() {
  return Promise.resolve({ isFile: () => true });
}

function verifiedRuntime({ help = REQUIRED_AGY_HELP_FLAGS.join(" "), version = SUPPORTED_AGY_VERSION } = {}) {
  const calls = [];
  const verifier = createRuntimeVerifier({
    env: { Path: "C:\\Windows", USERPROFILE: "C:\\Users\\test", API_KEY: "must-not-pass" },
    platform: "win32",
    stat: fakeStat,
    hashFile: async () => SUPPORTED_AGY_SHA256.toLowerCase(),
    signatureVerifier: async () => ({ trusted: true, signer: "CN=Google LLC" }),
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, args[0] === "--version" ? `agy ${version}\n` : `${help}\n`, "");
    },
  });
  return { verifier, calls };
}

test("safe Agy environment is allowlisted, immutable, and disables updating", () => {
  const source = {
    Path: "C:\\Windows;C:\\Tools",
    HOME: "C:\\Users\\test\\.agy-supervisor\\agy-profile",
    USERPROFILE: "C:\\Users\\test",
    CI: "false",
    HTTP_PROXY: "http://proxy.test:8080",
    HTTPS_PROXY: "https://proxy.test:8443",
    ALL_PROXY: "socks5://user:password@proxy.test:1080",
    API_KEY: "secret",
    SESSION_TOKEN: "secret",
    AUTHORIZATION: "secret",
    RANDOM_VALUE: "not-allowed",
    AGY_CLI_DISABLE_AUTO_UPDATE: "false",
  };
  const safe = buildSafeAgyEnvironment(source);

  assert.equal(safe.PATH, source.Path);
  assert.equal(safe.HOME, source.HOME);
  assert.equal(safe.USERPROFILE, source.USERPROFILE);
  assert.equal(safe.HTTP_PROXY, source.HTTP_PROXY);
  assert.equal(safe.HTTPS_PROXY, source.HTTPS_PROXY);
  assert.equal("ALL_PROXY" in safe, false);
  assert.equal(safe.CI, "true");
  assert.equal(safe.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal("API_KEY" in safe, false);
  assert.equal("SESSION_TOKEN" in safe, false);
  assert.equal("AUTHORIZATION" in safe, false);
  assert.equal("RANDOM_VALUE" in safe, false);
  assert.equal(source.AGY_CLI_DISABLE_AUTO_UPDATE, "false");
  assert.equal(source.CI, "false");
  assert.equal(
    defaultAgyPath({ env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, platform: "win32" }),
    "C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe",
  );
});

test("Windows user ProxyServer parsing supplies only enabled credential-free HTTP proxies", async () => {
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:7897"), {
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
  });
  assert.deepEqual(parseWindowsProxyServer("http=127.0.0.1:7897;https=127.0.0.1:7898"), {
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7898",
  });
  assert.deepEqual(parseWindowsProxyServer("http=http://user:password@127.0.0.1:7897;https=127.0.0.1:7898"), {
    HTTPS_PROXY: "http://127.0.0.1:7898",
  });
  assert.deepEqual(parseWindowsProxyServer("http=ftp://127.0.0.1:7897;https=127.0.0.1:7898"), {
    HTTPS_PROXY: "http://127.0.0.1:7898",
  });
  assert.deepEqual(parseWindowsProxyServer("http://user:password@127.0.0.1:7897"), {});
  assert.deepEqual(parseWindowsProxyServer("ftp://127.0.0.1:7897"), {});
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:7897", { enabled: false }), {});

  const calls = [];
  const userProxy = await readWindowsUserProxyEnvironment({
    env: { SystemRoot: "C:\\Windows" },
    platform: "win32",
    execFile(_file, args, _options, callback) {
      calls.push(args);
      const output = args.includes("ProxyEnable")
        ? "ProxyEnable    REG_DWORD    0x1\n"
        : "ProxyServer    REG_SZ    127.0.0.1:7897\n";
      callback(null, output, "");
    },
  });
  assert.deepEqual(userProxy, {
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
  });
  assert.equal(calls.length >= 2, true);
});

test("runtime verifier accepts only the pinned capability surface", async () => {
  const { verifier, calls } = verifiedRuntime();
  const report = await verifier.verify({ agyPath: fakePath });

  assert.equal(report.ok, true);
  assert.equal(report.version, SUPPORTED_AGY_VERSION);
  assert.equal(report.sha256, SUPPORTED_AGY_SHA256);
  assert.equal(report.defaults.model, DEFAULT_AGY_MODEL);
  assert.equal(report.defaults.effort, DEFAULT_AGY_EFFORT);
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["--help"]]);
  assert.equal(calls.every((call) => call.options.timeout > 0 && call.options.maxBuffer > 0), true);
  assert.equal(calls.every((call) => call.options.env.AGY_CLI_DISABLE_AUTO_UPDATE === "true"), true);
  assert.equal(calls.every((call) => !("API_KEY" in call.options.env)), true);
});

test("runtime verifier accepts Go-style help written to stderr", async () => {
  const stderrVerifier = createRuntimeVerifier({
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    platform: "win32",
    stat: fakeStat,
    hashFile: async () => SUPPORTED_AGY_SHA256,
    signatureVerifier: async () => ({ trusted: true, signer: "CN=Google LLC" }),
    execFile(_file, args, _options, callback) {
      if (args[0] === "--version") callback(null, `${SUPPORTED_AGY_VERSION}\n`, "");
      else callback(null, "", REQUIRED_AGY_HELP_FLAGS.join(" "));
    },
  });

  assert.equal((await stderrVerifier.verify({ agyPath: fakePath })).ok, true);
});

test("runtime identity is verified before execution and rechecked afterward", async () => {
  const order = [];
  const verifier = createRuntimeVerifier({
    platform: "win32",
    stat: async () => {
      order.push("stat");
      return { isFile: () => true };
    },
    hashFile: async () => {
      order.push("hash");
      return SUPPORTED_AGY_SHA256;
    },
    signatureVerifier: async () => {
      order.push("signature");
      return { trusted: true, signer: "CN=Google LLC" };
    },
    execFile(_file, args, _options, callback) {
      order.push(args[0]);
      callback(null, args[0] === "--version" ? SUPPORTED_AGY_VERSION : REQUIRED_AGY_HELP_FLAGS.join(" "), "");
    },
  });

  assert.equal((await verifier.verify({ agyPath: fakePath })).ok, true);
  assert.deepEqual(order, ["stat", "hash", "signature", "--version", "--help", "hash"]);
});

test("runtime verifier fails closed for missing stream flags", async () => {
  const { verifier } = verifiedRuntime({ help: REQUIRED_AGY_HELP_FLAGS.slice(0, -1).join(" ") });
  const report = await verifier.verify({ agyPath: fakePath });

  assert.equal(report.ok, false);
  assert.equal(report.failureKind, "MISSING_REQUIRED_FLAGS");
  assert.equal(report.capabilities.streamJson, false);
});

test("runtime verifier classifies authentication failures without exposing stderr", async () => {
  const verifier = createRuntimeVerifier({
    platform: "win32",
    stat: fakeStat,
    hashFile: async () => SUPPORTED_AGY_SHA256,
    signatureVerifier: async () => ({ trusted: true, signer: "Google LLC" }),
    execFile(_file, _args, _options, callback) {
      callback(new Error("failed"), "", "Please sign in in an interactive terminal");
    },
  });
  const report = await verifier.verify({ agyPath: fakePath });

  assert.equal(report.ok, false);
  assert.equal(report.failureKind, "AUTH_REQUIRED_IN_USER_TERMINAL");
  assert.equal(JSON.stringify(report).includes("interactive terminal"), false);
  assert.equal(classifyAgyStderr("The keyring is unavailable"), "KEYRING_UNAVAILABLE");
  assert.equal(classifyAgyStderr("unrelated failure"), "RUNTIME_ERROR");
});
