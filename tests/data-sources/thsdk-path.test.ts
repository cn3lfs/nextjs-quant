import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_THSDK_DLL } from "~/server/data-sources/thsdk/thsdk-known-hashes";
import {
  hasBundledThsdkDll,
  inspectThsdkDllFile,
  resolveBundledThsdkDllPath,
  stageBundledThsdkDll,
  stageThsdkDll,
  validateThsdkDllPath,
  type ThsdkPathErrorCode,
} from "~/server/data-sources/thsdk/thsdk-path";

function safePathError(code: ThsdkPathErrorCode, path: string) {
  return expect.objectContaining({
    name: "ThsdkPathError",
    code,
    message: expect.not.stringContaining(path),
  });
}

it.each([
  ["UNC share", "\\\\fixture-server\\private\\hq.dll"],
  ["extended-length path", "\\\\?\\C:\\private-fixture\\hq.dll"],
  ["relative path", "private-fixture\\hq.dll"],
  ["alternate data stream", "C:\\private-fixture\\hq.dll:secret"],
  ["trailing space", "C:\\private-fixture\\hq.dll "],
  ["space at an intermediate segment end", "C:\\private-fixture \\hq.dll"],
])("rejects a %s with a redacted error", (_kind, path) => {
  expect(() => validateThsdkDllPath(path)).toThrow(
    safePathError("invalid_path", path),
  );
});

function peFixture(machine = 0x8664, marker = 0): Buffer {
  const bytes = Buffer.alloc(71);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(machine, 68);
  bytes[70] = marker;
  return bytes;
}

describe.skipIf(process.platform !== "win32")("Windows DLL filesystem", () => {
  let root: string;
  let sourcePath: string;
  let sessionRoot: string;

  beforeEach(() => {
    // Some Windows temp roots are aliases. Use the canonical source path.
    root = realpathSync.native(
      mkdtempSync(join(process.env.QUANT_DATA_DIR!, "dll-")),
    );
    sourcePath = join(root, "source-hq.dll");
    sessionRoot = join(root, "session");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a directory junction even when its target has a valid x64 header", () => {
    writeFileSync(sourcePath, peFixture());
    const junction = join(root, "redirected");
    symlinkSync(root, junction, "junction");
    const alias = join(junction, "source-hq.dll");
    try {
      expect(lstatSync(junction).isSymbolicLink()).toBe(true);
      expect(readFileSync(alias)).toEqual(peFixture());
      expect(() => validateThsdkDllPath(alias)).toThrow(
        safePathError("invalid_path", alias),
      );
    } finally {
      rmSync(junction);
    }
  });

  it.each([
    ["missing MZ header", () => Buffer.alloc(71)],
    ["truncated PE header", () => peFixture().subarray(0, 68)],
    [
      "missing PE signature",
      () => Buffer.concat([peFixture().subarray(0, 64), Buffer.alloc(7)]),
    ],
    ["32-bit x86 PE", () => peFixture(0x014c)],
  ])("rejects a DLL with %s", (_label, fixture) => {
    writeFileSync(sourcePath, fixture());
    expect(() => inspectThsdkDllFile(sourcePath)).toThrow(
      safePathError("invalid_pe", sourcePath),
    );
  });

  it("blocks unlisted x64 DLLs by default without creating a staging directory", async () => {
    const bytes = peFixture();
    writeFileSync(sourcePath, bytes);
    expect(inspectThsdkDllFile(sourcePath)).toEqual({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      knownVersion: null,
    });
    await expect(
      stageThsdkDll(sourcePath, { sessionRoot }),
    ).rejects.toMatchObject(safePathError("unlisted_hash", sourcePath));
    expect(existsSync(sessionRoot)).toBe(false);
  });

  it("redacts both the source and destination when staging cannot create its directory", async () => {
    writeFileSync(sourcePath, peFixture());
    writeFileSync(sessionRoot, "fixture blocking directory creation");
    const staged = stageThsdkDll(sourcePath, {
      sessionRoot,
      allowUnlistedHash: true,
    });
    await expect(staged).rejects.toMatchObject(
      safePathError("io_error", sourcePath),
    );
    await expect(staged).rejects.toMatchObject(
      safePathError("io_error", sessionRoot),
    );
  });

  it("reuses an identical staged DLL without replacing or rewriting it", async () => {
    writeFileSync(sourcePath, peFixture());
    const options = { sessionRoot, allowUnlistedHash: true };
    const first = await stageThsdkDll(sourcePath, options);
    utimesSync(first.stagedPath, 1000000000, 1000000000);
    const before = lstatSync(first.stagedPath, { bigint: true });
    expect(await stageThsdkDll(sourcePath, options)).toEqual(first);
    expect(lstatSync(first.stagedPath, { bigint: true })).toMatchObject({
      ino: before.ino,
      mtimeNs: before.mtimeNs,
    });
  });

  it("stages an explicitly allowed x64 DLL by content hash and prunes the previous hash", async () => {
    const options = { sessionRoot, allowUnlistedHash: true };
    const dllRoot = join(sessionRoot, "dll");
    writeFileSync(sourcePath, peFixture());
    const previous = await stageThsdkDll(sourcePath, options);
    expect(existsSync(previous.stagedPath)).toBe(true);

    const updated = peFixture(0x8664, 1);
    writeFileSync(sourcePath, updated);
    const sha256 = createHash("sha256").update(updated).digest("hex");
    const stagedPath = join(dllRoot, sha256, "hq.dll");
    expect(await stageThsdkDll(sourcePath, options)).toEqual({
      sourcePath,
      stagedPath,
      sha256,
      bytes: updated.length,
      knownVersion: null,
    });
    expect(previous.sha256).not.toBe(sha256);
    expect(readdirSync(dllRoot)).toEqual([sha256]);
    expect(readdirSync(join(dllRoot, sha256))).toEqual(["hq.dll"]);
    expect(readFileSync(stagedPath)).toEqual(updated);
    expect(readFileSync(sourcePath)).toEqual(updated);
  });

  it("stages the pinned bundled hq.dll and rejects a tampered workspace copy", async () => {
    expect(hasBundledThsdkDll()).toBe(true);
    const staged = await stageBundledThsdkDll({ sessionRoot });
    expect(staged).toMatchObject({
      sha256: BUNDLED_THSDK_DLL.sha256,
      bytes: BUNDLED_THSDK_DLL.bytes,
      knownVersion: BUNDLED_THSDK_DLL.version,
    });
    expect(existsSync(staged.stagedPath)).toBe(true);

    const fakeWorkspace = join(root, "fake-workspace");
    mkdirSync(join(fakeWorkspace, "runtime", "thsdk"), { recursive: true });
    const fakeDll = join(fakeWorkspace, "runtime", "thsdk", "hq.dll");
    writeFileSync(fakeDll, peFixture());
    expect(hasBundledThsdkDll(fakeWorkspace)).toBe(true);
    expect(resolveBundledThsdkDllPath(fakeWorkspace)).toBe(fakeDll);
    await expect(
      stageBundledThsdkDll({
        root: fakeWorkspace,
        sessionRoot: join(root, "tampered-session"),
      }),
    ).rejects.toMatchObject(safePathError("unlisted_hash", fakeDll));
  });
});
