import { readdir, stat } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const deliveryFilePageSchema = z.object({
  directory: z.string().trim().min(1).max(2048),
  keyword: z.string().trim().max(255).default(""),
  offset: z.number().int().nonnegative().default(0),
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export async function deliveryFilePage(raw: unknown) {
  const input = deliveryFilePageSchema.parse(raw),
    directory = resolve(input.directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        [".csv", ".txt", ".xls"].includes(extname(entry.name).toLowerCase()),
    )
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const version = createHash("sha256")
    .update(JSON.stringify([directory, names]))
    .digest("hex");
  if (input.version && input.version !== version)
    throw new Error("目录文件已变化，请重新检索");
  const matches = names.filter((name) =>
    name.toLowerCase().includes(input.keyword.toLowerCase()),
  );
  const selected = matches.slice(input.offset, input.offset + 20);
  const items: {
    name: string;
    path: string;
    size: number | null;
    modifiedAt: number | null;
    error: string | null;
  }[] = [];
  // Stat only the requested page, in batches of four. No unbounded fan-out.
  for (let i = 0; i < selected.length; i += 4) {
    items.push(
      ...(await Promise.all(
        selected.slice(i, i + 4).map(async (name) => {
          const path = join(directory, name);
          try {
            const info = await stat(path);
            if (!info.isFile()) throw new Error("所选路径已不是文件");
            return {
              name,
              path,
              size: info.size,
              modifiedAt: info.mtimeMs,
              error: null,
            };
          } catch {
            return {
              name,
              path,
              size: null,
              modifiedAt: null,
              error: "文件已消失或无法读取，请重新检索",
            };
          }
        }),
      )),
    );
  }
  return {
    directory,
    version,
    items,
    count: matches.length,
    nextOffset: input.offset + 20 < matches.length ? input.offset + 20 : null,
  };
}
