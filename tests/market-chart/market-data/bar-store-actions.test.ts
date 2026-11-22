import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as tdx from "tstdx/local";
import fixture from "../../fixtures/tdx-gbbq.json";
import { corporateActions } from "~/server/market/bar-store/corporate-actions";
import * as localSource from "~/server/market/bar-store/local-source";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

it("shares a whole-market parse across concurrent reads, invalidates on source change and recovers after failure", async () => {
  const root = await mkdtemp(
    join(process.env.QUANT_DATA_DIR!, "actions-sharing-"),
  );
  const parent = join(root, "T0002/hq_cache");
  await mkdir(parent, { recursive: true });
  const file = join(parent, "gbbq");
  const bytes = Buffer.from(fixture.gbbqBase64, "base64");
  await writeFile(file, bytes);
  const read = vi.spyOn(tdx, "parseGbbqFile");
  const fileReads = vi.mocked(readFile).mockClear();
  try {
    const batch = await Promise.all(
      Array.from({ length: 8 }, () => corporateActions(root)),
    );
    // Each caller verifies the complete file, so the two reads are per call.
    expect(fileReads.mock.calls.filter(([path]) => path === file)).toHaveLength(
      16,
    );
    expect(read).toHaveBeenCalledTimes(1);
    const events = tdx.parseGbbq(bytes);
    for (const result of batch) expect(result.events).toEqual(events);
    expect(read).toHaveBeenCalledTimes(1);
    await corporateActions(root);
    expect(read).toHaveBeenCalledTimes(1);
    expect(fileReads.mock.calls.filter(([path]) => path === file)).toHaveLength(
      18,
    );
    await writeFile(file, Buffer.alloc(4));
    const changed = await corporateActions(root);
    expect(changed.events.size).toBe(0);
    expect(changed.fingerprint).not.toBe(batch[0]!.fingerprint);
    expect(read).toHaveBeenCalledTimes(2);
    await unlink(file);
    await expect(corporateActions(root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(file, bytes);
    expect((await corporateActions(root)).events).toEqual(events);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    read.mockRestore();
  }
});

it("rejects a same-size rewrite between reads and retries with the new content", async () => {
  const root = await mkdtemp(
    join(process.env.QUANT_DATA_DIR!, "actions-race-"),
  );
  const parent = join(root, "T0002/hq_cache");
  const file = join(parent, "gbbq");
  const bytes = Buffer.from(fixture.gbbqBase64, "base64");
  const changed = Buffer.from(bytes);
  changed.writeUInt32LE(0);
  await mkdir(parent, { recursive: true });
  await writeFile(file, bytes);
  const fingerprint = vi
    .spyOn(localSource, "sourceFingerprint")
    .mockResolvedValue("fixed-stat");
  const read = vi.spyOn(tdx, "parseGbbqFile");
  vi.mocked(readFile).mockImplementationOnce(async () => {
    await writeFile(file, changed);
    return bytes;
  });
  try {
    await expect(corporateActions(root)).rejects.toThrow(
      "读取期间公司行动来源变化",
    );
    expect(read).not.toHaveBeenCalled();
    expect((await corporateActions(root)).events.size).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    fingerprint.mockRestore();
    read.mockRestore();
  }
});
