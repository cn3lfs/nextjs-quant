import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSecret,
  readSecret,
  saveSecret,
  VaultError,
} from "~/server/vault";

const secretId = "thsdk-test-credentials";
const credentials = { username: "测试账号", password: "fixture-password" };

describe.skipIf(process.platform !== "win32")("Windows DPAPI vault", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(process.env.QUANT_DATA_DIR!, "vault-"));
    vi.stubEnv("QUANT_DATA_DIR", root);
    file = join(root, "credentials", secretId + ".bin");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists encrypted credentials with a stable fingerprint and reads them back", async () => {
    expect(await readSecret(secretId)).toBeUndefined();
    const expectedFingerprint = createHash("sha256")
      .update(
        secretId + '\0{"password":"fixture-password","username":"测试账号"}',
      )
      .digest("hex");
    expect(await saveSecret(secretId, credentials)).toEqual({
      fingerprint: expectedFingerprint,
    });
    const encoded = readFileSync(file, "utf8");
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const bytes = Buffer.from(encoded, "base64");
    expect(bytes.includes(Buffer.from(credentials.password))).toBe(false);
    expect(bytes.includes(Buffer.from(credentials.username))).toBe(false);
    expect(await readSecret<typeof credentials>(secretId)).toEqual(credentials);
  });

  it("deletes an existing secret and treats ENOENT as successful deletion", async () => {
    await saveSecret(secretId, credentials);
    expect(existsSync(file)).toBe(true);
    expect(await deleteSecret(secretId)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(await readSecret(secretId)).toBeUndefined();
    expect(await deleteSecret(secretId)).toBe(true);
  });

  it("rejects tampered DPAPI ciphertext as a VaultError", async () => {
    await saveSecret(secretId, credentials);
    const bytes = Buffer.from(readFileSync(file, "utf8"), "base64");
    const index = Math.floor(bytes.length / 2);
    bytes[index] = bytes[index]! ^ 0xff;
    writeFileSync(file, bytes.toString("base64"));
    await expect(readSecret(secretId)).rejects.toBeInstanceOf(VaultError);
  });

  it("reports corrupt JSON inside an otherwise valid DPAPI envelope", async () => {
    await saveSecret(secretId, credentials);
    const encrypted = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference='Stop'",
          "Add-Type -AssemblyName System.Security",
          "$bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())",
          "$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')",
          "[Console]::Out.Write([Convert]::ToBase64String($encrypted))",
        ].join("; "),
      ],
      {
        input: '{"incomplete":',
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    expect(encrypted.status).toBe(0);
    expect(encrypted.stdout).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    writeFileSync(file, encrypted.stdout);
    const read = readSecret(secretId);
    await expect(read).rejects.toBeInstanceOf(VaultError);
    await expect(read).rejects.toMatchObject({ code: "corrupt" });
  });
});
