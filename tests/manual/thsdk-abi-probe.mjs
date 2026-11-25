/**
 * Manual Windows x64 ABI & sample verification probe for THSDK hq.dll.
 * Usage:
 *   THSDK_DLL_PATH=<abs-path-to-hq.dll> THSDK_SESSION_DIR=<abs-dir> node tests/manual/thsdk-abi-probe.mjs
 * Never imports production DB or vault; does not call library.unload() on Go c-shared DLL.
 */
import koffi from "koffi";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dllPath = process.env.THSDK_DLL_PATH || "vendor/thsdk/hq.dll";
const resolvedDll = resolve(dllPath);
const rawDll = readFileSync(resolvedDll);
const sha256 = createHash("sha256").update(rawDll).digest("hex");
console.log(JSON.stringify({ dll: resolvedDll, bytes: rawDll.length, sha256 }));

const lib = koffi.load(resolvedDll);
const CallAlloc = lib.func("void *CallAlloc(const char *request_json)");
const FreeResult = lib.func("void FreeResult(void *ptr)");

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
function callNative(method, params, timeoutMs = 15000) {
  const req = { method };
  if (params !== undefined) req.params = params;
  if (timeoutMs !== undefined) req.timeout_ms = timeoutMs;
  const ptr = CallAlloc(JSON.stringify(req));
  if (!ptr) throw new Error(`Null pointer from CallAlloc(${method})`);
  let text;
  try {
    text = koffi.decode(ptr, "char", -1);
  } finally {
    FreeResult(ptr);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = callNative("version");
await sleep(80);
const strictProbe = callNative("version", { thsdk_protocol_probe: true });
await sleep(80);
const methods = callNative("methods");
console.log(
  JSON.stringify(
    {
      versionOk: version.ok,
      abiVersion: version.data?.abi_version,
      strictProbeRejected:
        !strictProbe.ok && strictProbe.error?.code === "invalid_request",
      methodsCount: Array.isArray(methods.data) ? methods.data.length : -1,
    },
    null,
    2,
  ),
);

if (process.env.THSDK_SESSION_DIR) {
  const sessionDir = resolve(process.env.THSDK_SESSION_DIR);
  mkdirSync(sessionDir, { recursive: true });
  await sleep(80);
  const auth = callNative("auth", { session_dir: sessionDir });
  console.log(
    JSON.stringify({
      sessionRestoreOk: auth.ok,
      authenticated: Boolean(auth.data?.authenticated),
    }),
  );
}

try {
  callNative("_close");
} catch {
  // Ignore close errors during probe exit.
}
process.exit(0);
