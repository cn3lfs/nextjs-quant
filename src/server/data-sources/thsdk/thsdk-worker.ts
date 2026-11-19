import koffi from "koffi";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import {
  THSDK_ABI_VERSION,
  THSDK_ALLOWED_READ_METHODS,
  THSDK_CONTROL_METHODS,
  THSDK_MAX_RESPONSE_BYTES,
  ThsdkError,
  isAllowedReadMethod,
  isMutatingMethod,
  sanitizeThsdkText,
  thsdkErrorCodes,
  thsdkRawResponseSchema,
  validateThsdkRequestJson,
  type ThsdkWorkerInitMessage,
  type ThsdkWorkerMessage,
  type ThsdkWorkerReply,
} from "./thsdk-contract";

// libuv restores Windows profile variables during spawn. Drop them before
// loading the Go runtime, which takes its own environment snapshot.
const allowedEnv = new Set(["SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_ENV"]);
for (const key of Object.keys(process.env)) {
  if (!allowedEnv.has(key.toUpperCase())) delete process.env[key];
}

function bindDll(path: string, expectedSha256: string) {
  try {
    const digest = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
    if (digest !== expectedSha256.toLowerCase()) throw new Error();
    const library = koffi.load(path);
    return {
      CallAlloc: library.func("void *CallAlloc(const char *request_json)"),
      FreeResult: library.func("void FreeResult(void *ptr)"),
    };
  } catch {
    throw new ThsdkError("dll_invalid", "THSDK 组件校验或加载失败");
  }
}

let native: ReturnType<typeof bindDll> | undefined;
let initialized = false;
let initStarted = false;

function callNative(method: string, params?: unknown, timeoutMs?: number) {
  const json = validateThsdkRequestJson(method, params, timeoutMs);
  if (!native) throw new ThsdkError("unavailable", "THSDK 组件尚未加载");
  const ptr: unknown = native.CallAlloc(json);
  if (!ptr) throw new ThsdkError("invalid_response", "THSDK 返回空指针");
  let text: unknown;
  try {
    text = koffi.decode(ptr, "char", -1);
  } finally {
    native.FreeResult(ptr);
  }
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > THSDK_MAX_RESPONSE_BYTES
  )
    throw new ThsdkError("invalid_response", "THSDK 响应文本无效或过大");
  try {
    const result = thsdkRawResponseSchema.safeParse(JSON.parse(text));
    if (result.success) return result.data;
  } catch {
    // Do not echo the native payload (auth replies can contain credentials).
  }
  throw new ThsdkError("invalid_response", "THSDK 响应格式无效");
}

async function handshakeCall(method: string, params?: unknown) {
  const response = callNative(method, params);
  const delay = response.error?.retry_after_ms;
  if (
    !response.ok &&
    response.error?.code === "rate_limited" &&
    delay !== undefined &&
    Number.isSafeInteger(delay) &&
    delay >= 0 &&
    delay <= 1000
  ) {
    await sleep(Math.max(65, delay));
    return callNative(method, params);
  }
  return response;
}

function watchParent(parentPid: number) {
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid !== process.ppid
  )
    throw new ThsdkError("invalid_request", "THSDK 父进程标识无效");
  // A blocked synchronous Go call cannot process disconnect or a port message.
  // SIGKILL targets this process, including its blocked FFI thread.
  const watchdog = new Worker(
    `const { workerData } = require("node:worker_threads");
     setInterval(() => {
       try { process.kill(workerData, 0); }
       catch (err) { if (err.code === "ESRCH") process.kill(process.pid, "SIGKILL"); }
     }, 1000);`,
    { eval: true, workerData: parentPid, execArgv: [] },
  );
  watchdog.on("error", () => process.exit(1));
  watchdog.unref();
}

async function initialize(
  message: ThsdkWorkerInitMessage,
): Promise<ThsdkWorkerReply> {
  if (initStarted) throw new ThsdkError("invalid_request", "THSDK 重复初始化");
  initStarted = true;
  watchParent(message.parentPid);
  native = bindDll(message.dllPath, message.expectedSha256);
  const version = await handshakeCall("version");
  const data = version.data;
  if (
    !version.ok ||
    !data ||
    typeof data !== "object" ||
    !("abi_version" in data) ||
    data.abi_version !== THSDK_ABI_VERSION
  )
    throw new ThsdkError("handshake_failed", "THSDK ABI 版本不匹配");
  const probe = await handshakeCall("version", { thsdk_protocol_probe: true });
  if (probe.ok || probe.error?.code !== "invalid_request")
    throw new ThsdkError("handshake_failed", "THSDK 未通过严格协议探针");
  const methods = await handshakeCall("methods");
  if (
    !methods.ok ||
    !Array.isArray(methods.data) ||
    !methods.data.every((method: unknown) => typeof method === "string")
  )
    throw new ThsdkError("handshake_failed", "THSDK 方法清单无效");
  const names = new Set<string>(methods.data);
  for (const method of THSDK_ALLOWED_READ_METHODS) {
    if (!names.has(method))
      throw new ThsdkError("handshake_failed", "THSDK 缺少只读方法 " + method);
  }
  initialized = true;
  return {
    id: message.id,
    ok: true,
    abiVersion: THSDK_ABI_VERSION,
    methodsCount: names.size,
  };
}

function shutdown(): never {
  try {
    if (native) callNative("_close");
  } finally {
    process.exit(0);
  }
}

async function handle(message: ThsdkWorkerMessage): Promise<ThsdkWorkerReply> {
  if (message.type === "shutdown") shutdown();
  if (message.type === "init") return initialize(message);
  if (message.type !== "call")
    throw new ThsdkError("invalid_request", "未知 IPC 请求");
  const { id, kind, method, params, timeoutMs } = message;
  const allowed =
    kind === "read"
      ? !isMutatingMethod(method) && isAllowedReadMethod(method)
      : kind === "control" && THSDK_CONTROL_METHODS.has(method);
  if (!allowed)
    throw new ThsdkError("method_forbidden", "此调用通道禁止该方法");
  if (!initialized) throw new ThsdkError("unavailable", "THSDK 尚未通过握手");
  const result = callNative(method, params, timeoutMs);
  if (result.ok) return { id, ok: true, data: result.data };
  const error = result.error;
  const code =
    thsdkErrorCodes.find((item) => item === error?.code) ??
    (error?.code === "not_authenticated" ? "auth_required" : "unavailable");
  throw new ThsdkError(
    code,
    sanitizeThsdkText(error?.message ?? "THSDK 调用失败"),
    error?.retry_after_ms,
  );
}

process.on("disconnect", shutdown);
process.on("message", (message: ThsdkWorkerMessage) => {
  if (!message || !Number.isSafeInteger(message.id)) return;
  void handle(message)
    .catch((cause: unknown): ThsdkWorkerReply => {
      const error =
        cause instanceof ThsdkError
          ? cause
          : new ThsdkError("unavailable", "THSDK 原生调用失败");
      return {
        id: message.id,
        ok: false,
        errorCode: error.code,
        safeMessage: sanitizeThsdkText(error.safeMessage),
        retryAfterMs: error.retryAfterMs,
      };
    })
    .then((reply) => {
      if (process.connected)
        process.send?.(reply, (error: Error | null) => {
          if (error) shutdown();
        });
    });
});
