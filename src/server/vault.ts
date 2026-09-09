import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./db";
async function crypt(input: string, decrypt: boolean): Promise<string> {
  if (process.platform !== "win32")
    throw new Error("凭证存储当前支持 Windows DPAPI");
  return new Promise((resolve, reject) => {
    const operation = decrypt ? "Unprotect" : "Protect";
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
      (error, stdout) =>
        error
          ? reject(new Error("系统凭证存储不可用"))
          : resolve(stdout.trim()),
    );
    child.stdin?.end(input);
  });
}
export async function saveSecret(id: string, value: unknown) {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法凭证标识");
  const dir = join(dataDirectory(), "credentials");
  await mkdir(dir, { recursive: true });
  const encoded = await crypt(
      Buffer.from(JSON.stringify(value)).toString("base64"),
      false,
    ),
    file = join(dir, `${id}.bin`);
  await writeFile(`${file}.tmp`, encoded, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export async function readSecret<T>(id: string): Promise<T | undefined> {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法凭证标识");
  let encrypted: string;
  try {
    encrypted = await readFile(
      join(dataDirectory(), "credentials", `${id}.bin`),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(
    Buffer.from(await crypt(encrypted, true), "base64").toString("utf8"),
  ) as T;
}
