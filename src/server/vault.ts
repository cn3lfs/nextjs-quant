import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./infra/paths";

export type VaultErrorCode = "unavailable" | "corrupt" | "invalid-id";

export class VaultError extends Error {
  constructor(
    public readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

const secretIdPattern = /^[\w-]+$/;

function assertSecretId(id: string): void {
  if (!secretIdPattern.test(id))
    throw new VaultError("invalid-id", "非法凭证标识");
}

function secretFile(id: string): string {
  return join(dataDirectory(), "credentials", `${id}.bin`);
}

async function crypt(input: string, decrypt: boolean): Promise<string> {
  if (process.platform !== "win32")
    throw new VaultError("unavailable", "凭证存储当前支持 Windows DPAPI");
  return new Promise((resolve, reject) => {
    const operation = decrypt ? "Unprotect" : "Protect";
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
      (error, stdout) =>
        error
          ? reject(new VaultError("unavailable", "系统凭证存储不可用"))
          : resolve(stdout.trim()),
    );
    child.stdin?.end(input);
  });
}

/** Stable digest so callers can detect a secret change without reading it back. */
export function secretFingerprint(id: string, value: unknown): string {
  return createHash("sha256")
    .update(id)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export async function saveSecret(
  id: string,
  value: unknown,
): Promise<{ fingerprint: string }> {
  assertSecretId(id);
  const file = secretFile(id);
  await mkdir(join(dataDirectory(), "credentials"), { recursive: true });
  const encoded = await crypt(
    Buffer.from(JSON.stringify(value)).toString("base64"),
    false,
  );
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, encoded, { mode: 0o600 });
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new VaultError("unavailable", "凭证文件写入失败");
  }
  return { fingerprint: secretFingerprint(id, value) };
}

export async function readSecret<T>(id: string): Promise<T | undefined> {
  assertSecretId(id);
  let encrypted: string;
  try {
    encrypted = await readFile(secretFile(id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new VaultError("unavailable", "凭证文件不可读");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(await crypt(encrypted, true), "base64").toString(
      "utf8",
    );
  } catch {
    throw new VaultError("unavailable", "系统凭证存储不可用");
  }
  try {
    return JSON.parse(decoded) as T;
  } catch {
    throw new VaultError("corrupt", "凭证内容损坏");
  }
}

/** Missing files are already the desired end state, so ENOENT reports success. */
export async function deleteSecret(id: string): Promise<boolean> {
  assertSecretId(id);
  try {
    await rm(secretFile(id), { force: true });
    return true;
  } catch {
    return false;
  }
}
