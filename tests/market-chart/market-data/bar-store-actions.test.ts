import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as tdx from "tstdx/local";
import fixture from "../../fixtures/tdx-gbbq.json";
import { corporateActions } from "~/server/market/bar-store/corporate-actions";

it("shares a whole-market parse across concurrent reads, invalidates on source change and recovers after failure", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "actions-sharing");
  const parent = join(root, "T0002/hq_cache");
  await mkdir(parent, { recursive: true });
  const file = join(parent, "gbbq");
  const bytes = Buffer.from(fixture.gbbqBase64, "base64");
  await writeFile(file, bytes);
  const read = vi.spyOn(tdx, "readGbbq");
  try {
    const batch = await Promise.all(
      Array.from({ length: 8 }, () => corporateActions(root)),
    );
    const events = tdx.parseGbbq(bytes);
    for (const result of batch) expect(result.events).toEqual(events);
    expect(read).toHaveBeenCalledTimes(1);
    await corporateActions(root);
    expect(read).toHaveBeenCalledTimes(1);
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
