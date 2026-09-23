import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseIndustryMembers,
  readIndustryBlocks,
} from "../../src/server/market/industry-blocks";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "industry-blocks-"));
  directories.push(root);
  await mkdir(join(root, "申万行业"));
  return root;
}
it("fixed byte fixture parses uppercase/mixed case and CRLF to canonical lowercase symbols", async () => {
  const bytes = await readFile(
    new URL("../fixtures/industry-members.bin", import.meta.url),
  );
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(true);
  expect(parseIndustryMembers(bytes, "sample.txt")).toEqual([
    "sz000423",
    "sh600519",
    "bj920001",
  ]);
  expect(
    parseIndustryMembers(Buffer.from("\uFEFFSZ000423\nSH600519\n"), "bom.txt"),
  ).toEqual(["sz000423", "sh600519"]);
  expect(parseIndustryMembers(Buffer.alloc(0), "empty.txt")).toEqual([]);
});
it.each([
  "SZ00042",
  "SH600519\rBAD\r",
  "SZ000423\r\n\r\nSH600519",
  "SZ000423\nSZ000423",
  "US123456",
  " SH600519",
  "SH600519\0",
])("illegal or duplicate line fails explicitly: %s", (input) => {
  expect(() => parseIndustryMembers(Buffer.from(input), "bad.txt")).toThrow(
    /bad.txt/,
  );
});
it("malformed bytes and oversized input are rejected", () => {
  expect(() =>
    parseIndustryMembers(Buffer.from([0xff, 0xfe, 0x80]), "bad.txt"),
  ).toThrow("UTF-8/ASCII");
  expect(() => parseIndustryMembers(Buffer.alloc(128001), "large.txt")).toThrow(
    "上限",
  );
});
it("reader touches only Shenwan txt files, preserves source bytes/mtime, and notices new contents", async () => {
  const root = await setup(),
    path = join(root, "申万行业/行业甲.txt");
  const bytes = Buffer.from("SZ000423\r\nSH600519\r\n");
  await writeFile(path, bytes);
  await mkdir(join(root, "概念"));
  await writeFile(join(root, "概念/概念.txt"), "bad");
  const before = await stat(path),
    snapshot = await readIndustryBlocks(root);
  expect(snapshot.files).toEqual([
    {
      name: "行业甲",
      file: "行业甲.txt",
      members: ["sz000423", "sh600519"],
      hash: createHash("sha256").update(bytes).digest("hex"),
      mtimeMs: before.mtimeMs,
    },
  ]);
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  await writeFile(path, "SZ000423\r\n");
  const changed = await readIndustryBlocks(root);
  expect(changed.files[0]!.hash).not.toBe(snapshot.files[0]!.hash);
  expect(changed.hash).not.toBe(snapshot.hash);
});
it("missing folder, missing files and malformed named file report errors instead of empty success", async () => {
  const root = await setup();
  await expect(readIndustryBlocks(join(root, "absent"))).rejects.toThrow(
    "申万行业名单读取失败",
  );
  await expect(readIndustryBlocks(root)).rejects.toThrow("名单缺失");
  await writeFile(join(root, "申万行业/坏行业.txt"), "INVALID");
  await expect(readIndustryBlocks(root)).rejects.toThrow(
    "坏行业.txt：第1行格式非法",
  );
});
it("reader rejects a file that disappears mid-read and cancellation propagates", async () => {
  const root = await setup(),
    path = join(root, "申万行业/消失.txt");
  await writeFile(path, "SZ000423");
  await expect(
    readIndustryBlocks(root, () => {
      throw new Error("rps-cancelled");
    }),
  ).rejects.toThrow("rps-cancelled");
  // Checkpoint precedes lstat; known violating input proves the missing-file boundary.
  const { unlinkSync } = await import("node:fs");
  await expect(
    readIndustryBlocks(root, () => unlinkSync(path)),
  ).rejects.toThrow("ENOENT");
});
