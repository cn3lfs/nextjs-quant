import { beforeEach, expect, it, vi } from "vitest";
import { resolve, relative, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const virtual = vi.hoisted(() => ({
  root: "",
  sizes: new Map<string, number>(),
  files: new Map<string, Buffer>(),
  writes: 0,
}));
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const inside = (path: unknown): path is string =>
    typeof path === "string" && path.startsWith(virtual.root);
  const absent = () =>
    Object.assign(new Error("fixture ENOENT"), { code: "ENOENT" });
  return {
    ...actual,
    readFile: async (
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) => {
      if (!inside(path)) return actual.readFile(path, options);
      const value = virtual.files.get(path);
      if (!value) throw absent();
      return value;
    },
    mkdir: async (
      path: Parameters<typeof actual.mkdir>[0],
      options?: Parameters<typeof actual.mkdir>[1],
    ) => (inside(path) ? undefined : actual.mkdir(path, options)),
    readdir: async (
      path: Parameters<typeof actual.readdir>[0],
      options?: Parameters<typeof actual.readdir>[1],
    ) => {
      if (!inside(path)) return actual.readdir(path, options);
      const entries = new Map<string, boolean>();
      for (const file of virtual.sizes.keys()) {
        const part = relative(path, file);
        if (part.startsWith("..") || !part) continue;
        const pieces = part.split(/[\\/]/);
        entries.set(pieces[0]!, pieces.length > 1);
      }
      return [...entries].map(([name, directory]) => ({
        name,
        isDirectory: () => directory,
        isFile: () => !directory,
      }));
    },
    stat: async (path: Parameters<typeof actual.stat>[0]) =>
      inside(path) ? { size: virtual.sizes.get(path) ?? 0 } : actual.stat(path),
    writeFile: async (
      path: Parameters<typeof actual.writeFile>[0],
      value: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      if (!inside(path)) return actual.writeFile(path, value, options);
      if (virtual.files.has(path))
        throw Object.assign(new Error("fixture EEXIST"), { code: "EEXIST" });
      const bytes = Buffer.from(value as Uint8Array);
      virtual.files.set(path, bytes);
      virtual.sizes.set(path, bytes.length);
      virtual.writes++;
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (!inside(from) || !inside(to)) return actual.rename(from, to);
      const bytes = virtual.files.get(from);
      if (!bytes) throw absent();
      virtual.files.set(to, bytes);
      virtual.files.delete(from);
      virtual.sizes.set(to, bytes.length);
      virtual.sizes.delete(from);
    },
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (!inside(path)) return actual.unlink(path);
      virtual.files.delete(path);
      virtual.sizes.delete(path);
    },
  };
});
beforeEach(() => {
  vi.resetModules();
  virtual.root = resolve(".test-data/lifecycle-20261116/l3");
  virtual.sizes.clear();
  virtual.files.clear();
  virtual.writes = 0;
});

it("shares the512MiB research budget across reports/checkpoints/plans while excluding the separate source cache", async () => {
  virtual.sizes.set(join(virtual.root, "reports", "old.gz"), 511 * 1024 ** 2);
  virtual.sizes.set(join(virtual.root, "sources", "rank.bin"), 512 * 1024 ** 2);
  const first = await import("../../scripts/lib/research/lifecycle-runner");
  await first.writeLifecycleArtifact(
    join(virtual.root, "checkpoints", "small.gz"),
    { actual: "small fixture" },
  );
  expect(virtual.writes).toBe(1);
  vi.resetModules();
  virtual.sizes.set(join(virtual.root, "reports", "old.gz"), 512 * 1024 ** 2);
  const cold = await import("../../scripts/lib/research/lifecycle-runner");
  await expect(
    cold.writeLifecycleArtifact(join(virtual.root, "plans", "next.gz"), {
      actual: "another small fixture",
    }),
  ).rejects.toThrow("combined research output budget");
  expect(virtual.writes).toBe(1);
});
it("hard-stops a post-serialization historical maxRSS peak even after current RSS is low, without publishing", async () => {
  const actual = process.resourceUsage();
  let calls = 0;
  const peak = vi.spyOn(process, "resourceUsage").mockImplementation(() => ({
    ...actual,
    maxRSS: ++calls === 1 ? 64 * 1024 : 4096 * 1024 + 1,
  }));
  try {
    const runner = await import("../../scripts/lib/research/lifecycle-runner");
    await expect(
      runner.writeLifecycleArtifact(join(virtual.root, "plans", "peak.gz"), {
        tiny: "no allocation needed",
      }),
    ).rejects.toThrow("artifact-serialized");
    expect(virtual.writes).toBe(0);
  } finally {
    peak.mockRestore();
  }
});
it("finishes a complete interrupted immutable artifact without rewriting its payload", async () => {
  const path = join(virtual.root, "reports", "immutable.gz"),
    value = { exact: "complete fixture" },
    bytes = gzipSync(Buffer.from(JSON.stringify(value)));
  virtual.files.set(`${path}.pending`, bytes);
  virtual.sizes.set(`${path}.pending`, bytes.length);
  const { writeLifecycleArtifact } =
    await import("../../scripts/lib/research/lifecycle-runner");
  await writeLifecycleArtifact(path, value);
  expect(JSON.parse(gunzipSync(virtual.files.get(path)!).toString())).toEqual(
    value,
  );
  expect(virtual.writes).toBe(0);
});
it("preserves a different complete interrupted fact for review instead of overwriting it", async () => {
  const path = join(virtual.root, "reports", "conflict.gz"),
    bytes = gzipSync(
      Buffer.from(JSON.stringify({ exact: "previous complete fixture" })),
    );
  virtual.files.set(`${path}.pending`, bytes);
  virtual.sizes.set(`${path}.pending`, bytes.length);
  const { writeLifecycleArtifact } =
    await import("../../scripts/lib/research/lifecycle-runner");
  await expect(
    writeLifecycleArtifact(path, { exact: "different" }),
  ).rejects.toThrow("preserve it for review");
  expect(virtual.files.get(`${path}.pending`)).toEqual(bytes);
  expect(virtual.writes).toBe(0);
});
