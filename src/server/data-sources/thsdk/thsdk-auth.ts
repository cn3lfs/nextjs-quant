import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { get, put } from "../../db";
import { dataDirectory, thsdkSessionRoot } from "../../infra/paths";
import { deleteSecret, readSecret, saveSecret } from "../../vault";
import {
  ThsdkError,
  deriveAccountMac,
  type ThsdkErrorCode,
} from "./thsdk-contract";
import { getThsdkClient } from "./thsdk-client";
import { pickThsdkGuestAccount } from "./thsdk-guest-accounts";
import {
  stageThsdkDll,
  ThsdkPathError,
  type StagedThsdkDll,
} from "./thsdk-path";

export type ThsdkConfig = {
  version: 1;
  enabled: boolean;
  dllPath: string;
  allowUnlistedHash: boolean;
  allowAutoFallback: boolean;
  authMode: "account" | "qrcode" | "guest";
  guestModeEnabled: boolean;
  updatedAt: number;
};

export type ThsdkAuthState =
  | "unconfigured"
  | "disabled"
  | "logged_out"
  | "qr_pending"
  | "authenticated"
  | "error";

export type ThsdkStatusSnapshot = {
  enabled: boolean;
  configured: boolean;
  dllPath: string;
  dllKnownVersion: string | null;
  allowUnlistedHash: boolean;
  allowAutoFallback: boolean;
  authMode: ThsdkConfig["authMode"];
  guestModeEnabled: boolean;
  hasSavedCredentials: boolean;
  state: ThsdkAuthState;
  activeMode: "account" | "qrcode" | "guest" | null;
  authGeneration: number;
  configRevision: string;
  lastErrorCode: ThsdkErrorCode | null;
  lastErrorMessage: string | null;
  circuitOpenUntil: number | null;
  updatedAt: number;
};

export const thsdkConfigSchema: z.ZodType<ThsdkConfig> = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  dllPath: z.string(),
  allowUnlistedHash: z.boolean(),
  allowAutoFallback: z.boolean(),
  authMode: z.enum(["account", "qrcode", "guest"]),
  guestModeEnabled: z.boolean(),
  updatedAt: z.number(),
});

const CONFIG_KIND = "thsdk-config";
const CONFIG_ID = "thsdk-config";
const CREDENTIAL_ID = "thsdk-credentials";
const AUTH_TIMEOUT_MS = 60_000;
const QR_START_TIMEOUT_MS = 20_000;
const QR_POLL_TIMEOUT_MS = 25_000;
const QR_CANCEL_TIMEOUT_MS = 10_000;
const LOGOUT_TIMEOUT_MS = 15_000;
const QR_SESSION_TIMEOUT_SECONDS = 120;
const QR_POLL_INTERVAL_MS = 1_000;
const MAX_SESSION_DIRECTORIES = 2;

type StoredCredentials = { username: string; password: string };

type QrSnapshot = {
  scanUrl: string | null;
  imageUrl: string | null;
  authenticated: boolean;
  state: string;
};

type RuntimeState = {
  state: ThsdkAuthState;
  activeMode: "account" | "qrcode" | "guest" | null;
  authGeneration: number;
  lastErrorCode: ThsdkErrorCode | null;
  lastErrorMessage: string | null;
  activeSessionDir: string | null;
  dllKnownVersion: string | null;
  circuitOpenUntil: number | null;
};

const runtime: RuntimeState = {
  state: "logged_out",
  activeMode: null,
  authGeneration: 0,
  lastErrorCode: null,
  lastErrorMessage: null,
  activeSessionDir: null,
  dllKnownVersion: null,
  circuitOpenUntil: null,
};

const authResponseSchema = z.object({ authenticated: z.boolean().optional() });

const qrStateSchema = z.object({
  authenticated: z.boolean().optional(),
  state: z.string().optional(),
  scan_url: z.string().nullish(),
  image_url: z.string().nullish(),
});

function defaultConfig(): ThsdkConfig {
  return {
    version: 1,
    enabled: false,
    dllPath: "",
    allowUnlistedHash: false,
    allowAutoFallback: false,
    authMode: "account",
    guestModeEnabled: false,
    updatedAt: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readThsdkConfig(): ThsdkConfig {
  if (!existsSync(join(dataDirectory(), "quant.sqlite")))
    return defaultConfig();
  const stored = get<unknown>(CONFIG_ID);
  const parsed = thsdkConfigSchema.safeParse({
    ...defaultConfig(),
    ...asRecord(stored),
  });
  return parsed.success ? parsed.data : defaultConfig();
}

export function saveThsdkConfig(
  patch: Partial<Omit<ThsdkConfig, "version" | "updatedAt">>,
): ThsdkConfig {
  const current = readThsdkConfig();
  const next = thsdkConfigSchema.parse({
    ...current,
    ...patch,
    version: 1,
    updatedAt: Date.now(),
  });
  put(CONFIG_KIND, CONFIG_ID, next);
  if (
    patch.enabled === false ||
    (patch.guestModeEnabled === false && runtime.activeMode === "guest") ||
    (patch.dllPath !== undefined && patch.dllPath !== current.dllPath) ||
    (patch.authMode !== undefined && patch.authMode !== current.authMode)
  )
    invalidateAuthentication();
  return next;
}

/** Pure read: never spawns the worker and never decrypts credentials. */
export function getThsdkStatus(): ThsdkStatusSnapshot {
  const config = readThsdkConfig();
  const configured = config.dllPath.trim().length > 0;
  const state: ThsdkAuthState = !config.enabled
    ? "disabled"
    : !configured
      ? "unconfigured"
      : runtime.state;
  return {
    enabled: config.enabled,
    configured,
    dllPath: config.dllPath,
    dllKnownVersion: runtime.dllKnownVersion,
    allowUnlistedHash: config.allowUnlistedHash,
    allowAutoFallback: config.allowAutoFallback,
    authMode: config.authMode,
    guestModeEnabled: config.guestModeEnabled,
    hasSavedCredentials: hasSavedCredentials(),
    state,
    activeMode: runtime.activeMode,
    authGeneration: runtime.authGeneration,
    configRevision: configRevision(config),
    lastErrorCode: runtime.lastErrorCode,
    lastErrorMessage: runtime.lastErrorMessage,
    circuitOpenUntil: runtime.circuitOpenUntil,
    updatedAt: config.updatedAt,
  };
}

export async function saveThsdkCredentials(
  username: string,
  password: string,
): Promise<{ saved: true }> {
  const account = username.trim();
  if (!account || !password)
    throw new ThsdkError("invalid_request", "账号和密码不能为空");
  try {
    await saveSecret(CREDENTIAL_ID, { username: account, password });
  } catch {
    throw new ThsdkError("unavailable", "账号凭据无法保存");
  }
  invalidateAuthentication();
  return { saved: true };
}

export async function forgetThsdkCredentials(): Promise<{ deleted: boolean }> {
  let deleted = false;
  try {
    deleted = await deleteSecret(CREDENTIAL_ID);
  } catch {
    deleted = false;
  }
  invalidateAuthentication();
  return { deleted };
}

export async function thsdkLoginAccount(
  signal?: AbortSignal,
): Promise<ThsdkStatusSnapshot> {
  const config = requireEnabledConfig();
  const credentials = await readStoredCredentials();
  if (!credentials) throw new ThsdkError("not_configured", "尚未保存账号凭据");
  // A failed personal login is surfaced as-is; guest mode is never implicit.
  return loginWithCredentials(
    config,
    "account",
    credentials.username,
    credentials.password,
    deriveAccountMac(credentials.username),
    signal,
  );
}

export async function thsdkLoginGuest(
  signal?: AbortSignal,
): Promise<ThsdkStatusSnapshot> {
  const config = requireEnabledConfig();
  if (!config.guestModeEnabled)
    throw new ThsdkError("disabled", "游客模式未启用");
  const account = pickThsdkGuestAccount();
  return loginWithCredentials(
    config,
    "guest",
    account.username,
    account.password,
    account.mac,
    signal,
  );
}

export async function thsdkStartQrcode(
  signal?: AbortSignal,
): Promise<QrSnapshot> {
  const config = requireEnabledConfig();
  const staged = await stageConfiguredDll(config);
  const sessionDir = sessionDirectory("qrcode", "local");
  await ensureSessionDirectory(sessionDir);
  const generation = runtime.authGeneration + 1;
  runtime.authGeneration = generation;
  runtime.state = "qr_pending";
  runtime.activeMode = "qrcode";
  runtime.activeSessionDir = sessionDir;
  runtime.lastErrorCode = null;
  runtime.lastErrorMessage = null;
  try {
    const data = await invokeControl<unknown>(
      "auth_qrcode",
      {
        session_dir: sessionDir,
        timeout_seconds: QR_SESSION_TIMEOUT_SECONDS,
        poll_interval_ms: QR_POLL_INTERVAL_MS,
      },
      staged,
      sessionDir,
      QR_START_TIMEOUT_MS,
      signal,
    );
    const snapshot = applyQrState(data, generation);
    if (snapshot.authenticated) await collectSessionDirectories(sessionDir);
    return snapshot;
  } catch (error) {
    const thsdkError = toThsdkError(error);
    if (runtime.authGeneration === generation) recordError(thsdkError);
    throw thsdkError;
  }
}

export async function thsdkPollQrcode(
  signal?: AbortSignal,
): Promise<QrSnapshot> {
  const config = requireEnabledConfig();
  const sessionDir = runtime.activeSessionDir;
  if (!sessionDir || runtime.activeMode !== "qrcode")
    throw new ThsdkError("auth_required", "没有进行中的二维码登录");
  const staged = await stageConfiguredDll(config);
  const generation = runtime.authGeneration;
  try {
    const data = await invokeControl<unknown>(
      "auth_qrcode",
      undefined,
      staged,
      sessionDir,
      QR_POLL_TIMEOUT_MS,
      signal,
    );
    const snapshot = applyQrState(data, generation);
    if (snapshot.authenticated) await collectSessionDirectories(sessionDir);
    return snapshot;
  } catch (error) {
    const thsdkError = toThsdkError(error);
    if (runtime.authGeneration === generation) recordError(thsdkError);
    throw thsdkError;
  }
}

export async function thsdkCancelQrcode(): Promise<{ cancelled: true }> {
  const sessionDir =
    runtime.activeMode === "qrcode" ? runtime.activeSessionDir : null;
  runtime.authGeneration += 1;
  runtime.state = "logged_out";
  runtime.activeMode = null;
  runtime.activeSessionDir = null;
  if (sessionDir) {
    try {
      const staged = await stageConfiguredDll(readThsdkConfig());
      await invokeControl(
        "auth_qrcode",
        { cancel: true },
        staged,
        sessionDir,
        QR_CANCEL_TIMEOUT_MS,
      );
    } catch {
      // Local cancellation already stands; a dead worker has nothing to cancel.
    }
  }
  return { cancelled: true };
}

export async function thsdkLogout(): Promise<ThsdkStatusSnapshot> {
  // Invalidate first so any in-flight ensure call cannot reuse the old session.
  const sessionDir = runtime.activeSessionDir;
  runtime.authGeneration += 1;
  runtime.state = "logged_out";
  runtime.activeMode = null;
  runtime.activeSessionDir = null;
  if (sessionDir) {
    try {
      const staged = await stageConfiguredDll(readThsdkConfig());
      await invokeControl(
        "logout",
        { session_dir: sessionDir },
        staged,
        sessionDir,
        LOGOUT_TIMEOUT_MS,
      );
    } catch (error) {
      const thsdkError = toThsdkError(error);
      runtime.lastErrorCode = thsdkError.code;
      runtime.lastErrorMessage = thsdkError.safeMessage;
    }
    await rm(join(sessionDir, "account.session"), { force: true }).catch(
      () => {},
    );
  }
  return getThsdkStatus();
}

export async function ensureThsdkAuthenticated(
  signal?: AbortSignal,
): Promise<{ sessionDir: string; authGeneration: number }> {
  const config = requireEnabledConfig();
  const generation = runtime.authGeneration;
  if (runtime.state === "authenticated" && runtime.activeSessionDir) {
    // A crashed worker loses its in-memory authentication; re-login instead of
    // handing callers a session the child process no longer owns.
    if (getThsdkClient().getState().running)
      return {
        sessionDir: runtime.activeSessionDir,
        authGeneration: generation,
      };
    runtime.state = "logged_out";
  }

  if (config.authMode === "account") await thsdkLoginAccount(signal);
  else if (config.authMode === "guest")
    throw new ThsdkError(
      "auth_required",
      "请先在系统设置中手动点击一键游客登录",
    );
  else throw new ThsdkError("auth_required", "二维码登录需要用户扫码");

  if (runtime.authGeneration === generation)
    throw new ThsdkError("auth_failed", "认证状态未建立");
  if (runtime.state !== "authenticated" || !runtime.activeSessionDir)
    throw new ThsdkError("session_expired", "认证会话已失效");
  return {
    sessionDir: runtime.activeSessionDir,
    authGeneration: runtime.authGeneration,
  };
}

function requireEnabledConfig(): ThsdkConfig {
  const config = readThsdkConfig();
  if (!config.enabled) throw new ThsdkError("disabled", "THSDK 数据源未启用");
  if (!config.dllPath.trim())
    throw new ThsdkError("not_configured", "尚未配置 THSDK DLL 路径");
  return config;
}

async function readStoredCredentials(): Promise<StoredCredentials | undefined> {
  let value: unknown;
  try {
    value = await readSecret<unknown>(CREDENTIAL_ID);
  } catch {
    throw new ThsdkError("unavailable", "账号凭据不可用");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as StoredCredentials).username !== "string" ||
    typeof (value as StoredCredentials).password !== "string" ||
    !(value as StoredCredentials).username ||
    !(value as StoredCredentials).password
  )
    return undefined;
  return {
    username: (value as StoredCredentials).username,
    password: (value as StoredCredentials).password,
  };
}

async function loginWithCredentials(
  config: ThsdkConfig,
  mode: "account" | "guest",
  username: string,
  password: string,
  mac: string,
  signal?: AbortSignal,
): Promise<ThsdkStatusSnapshot> {
  const staged = await stageConfiguredDll(config);
  const sessionDir = sessionDirectory(mode, username);
  await ensureSessionDirectory(sessionDir);
  const generation = runtime.authGeneration + 1;
  runtime.authGeneration = generation;
  runtime.state = "logged_out";
  runtime.activeMode = null;
  runtime.activeSessionDir = null;
  runtime.lastErrorCode = null;
  runtime.lastErrorMessage = null;
  try {
    const data = await invokeControl<unknown>(
      "auth",
      { session_dir: sessionDir, username, password, mac },
      staged,
      sessionDir,
      AUTH_TIMEOUT_MS,
      signal,
    );
    const parsed = authResponseSchema.safeParse(data);
    if (!parsed.success || parsed.data.authenticated !== true)
      throw new ThsdkError("auth_failed", "账号认证未完成");
  } catch (error) {
    const thsdkError = toThsdkError(error);
    if (runtime.authGeneration === generation) recordError(thsdkError);
    throw thsdkError;
  }
  if (runtime.authGeneration !== generation)
    throw new ThsdkError("cancelled", "认证已被新的操作取代");
  runtime.state = "authenticated";
  runtime.activeMode = mode;
  runtime.activeSessionDir = sessionDir;
  runtime.dllKnownVersion = staged.knownVersion;
  runtime.lastErrorCode = null;
  runtime.lastErrorMessage = null;
  await collectSessionDirectories(sessionDir);
  return getThsdkStatus();
}

async function stageConfiguredDll(
  config: ThsdkConfig,
): Promise<StagedThsdkDll> {
  if (!config.dllPath.trim())
    throw new ThsdkError("not_configured", "尚未配置 THSDK DLL 路径");
  try {
    const staged = await stageThsdkDll(config.dllPath, {
      allowUnlistedHash: config.allowUnlistedHash,
      sessionRoot: thsdkSessionRoot(),
    });
    runtime.dllKnownVersion = staged.knownVersion;
    return staged;
  } catch (error) {
    if (error instanceof ThsdkPathError)
      throw new ThsdkError("dll_invalid", error.message);
    throw new ThsdkError("dll_invalid", "THSDK DLL 校验失败");
  }
}

async function invokeControl<T>(
  method: string,
  params: unknown,
  staged: StagedThsdkDll,
  sessionDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const client = getThsdkClient();
  try {
    return await client.invokeControl<T>(method, params, {
      dllPath: staged.stagedPath,
      expectedSha256: staged.sha256,
      sessionDir,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
  } finally {
    try {
      runtime.circuitOpenUntil = client.getState().circuitOpenUntil;
    } catch {
      // Client diagnostics must never mask the call result.
    }
  }
}

function qrHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = URL.parse(value);
  return url && (url.protocol === "http:" || url.protocol === "https:")
    ? url.href
    : null;
}

function applyQrState(data: unknown, generation: number): QrSnapshot {
  const parsed = qrStateSchema.safeParse(data);
  if (!parsed.success)
    throw new ThsdkError("invalid_response", "二维码登录响应无效");
  if (runtime.authGeneration !== generation)
    throw new ThsdkError("cancelled", "二维码登录已被新的操作取代");
  const authenticated =
    parsed.data.authenticated === true || parsed.data.state === "authenticated";
  if (authenticated) {
    runtime.state = "authenticated";
    runtime.lastErrorCode = null;
    runtime.lastErrorMessage = null;
  } else {
    runtime.state = "qr_pending";
  }
  return {
    scanUrl: qrHttpUrl(parsed.data.scan_url),
    imageUrl:
      parsed.data.image_url &&
      /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(
        parsed.data.image_url,
      )
        ? parsed.data.image_url
        : qrHttpUrl(parsed.data.image_url),
    authenticated,
    state: parsed.data.state ?? (authenticated ? "authenticated" : "pending"),
  };
}

function sessionDirectory(mode: string, accountKey: string): string {
  const root = resolve(thsdkSessionRoot());
  if (root.startsWith("\\\\") || root.startsWith("//"))
    throw new ThsdkError("invalid_request", "会话目录不能位于网络共享");
  const digest = createHash("sha256")
    .update(`${mode}:${accountKey}`)
    .digest("hex")
    .slice(0, 16);
  return join(root, "sessions", digest);
}

async function ensureSessionDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    throw new ThsdkError("unavailable", "会话目录不可用");
  }
}

/** Keep the active session plus one most-recently-used fallback at most. */
async function collectSessionDirectories(keep: string): Promise<void> {
  const sessionsRoot = join(thsdkSessionRoot(), "sessions");
  let names: string[];
  try {
    names = await readdir(sessionsRoot);
  } catch {
    return;
  }
  const keepName = basename(keep);
  const candidates: { name: string; modifiedAt: number }[] = [];
  for (const name of names) {
    if (name === keepName) continue;
    try {
      const info = await lstat(join(sessionsRoot, name));
      if (info.isDirectory() && !info.isSymbolicLink())
        candidates.push({ name, modifiedAt: info.mtimeMs });
    } catch {
      // A concurrent login may remove a directory between readdir and stat.
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates.slice(MAX_SESSION_DIRECTORIES - 1))
    await rm(join(sessionsRoot, candidate.name), {
      recursive: true,
      force: true,
    }).catch(() => {});
}

function configRevision(config: ThsdkConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 16);
}

function hasSavedCredentials(): boolean {
  return existsSync(
    join(dataDirectory(), "credentials", `${CREDENTIAL_ID}.bin`),
  );
}

function invalidateAuthentication(): void {
  runtime.authGeneration += 1;
  runtime.state = "logged_out";
  runtime.activeMode = null;
  runtime.activeSessionDir = null;
  runtime.lastErrorCode = null;
  runtime.lastErrorMessage = null;
}

function recordError(error: ThsdkError): void {
  runtime.state = "error";
  runtime.lastErrorCode = error.code;
  runtime.lastErrorMessage = error.safeMessage;
}

function toThsdkError(error: unknown): ThsdkError {
  if (error instanceof ThsdkError) return error;
  if (error instanceof ThsdkPathError)
    return new ThsdkError("dll_invalid", error.message);
  return new ThsdkError("unavailable", "THSDK 服务不可用");
}
