import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGbbqFile, resolveTdxRoot } from "tstdx/local";
import { sourceFingerprint } from "./local-source";

type Entry = {
  statIdentity: string;
  sample: Buffer;
  ready: Promise<{
    events: ReturnType<typeof parseGbbqFile>["events"];
    modified: number;
    path: string;
    fingerprint: string;
  }>;
};

let current: Entry | undefined;
const sampleBytes = 4096;

async function sampleGbbq(path: string) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    const { size, mtimeMs } = info;
    if (!info.isFile() || size > 64 * 1024 * 1024)
      throw new Error("本地公司行动源不是常规文件或容量超限");
    const sample = Buffer.alloc(Math.min(size, 2 * sampleBytes));
    if (size <= sample.length) {
      const { bytesRead } = await file.read(sample, 0, size, 0);
      if (bytesRead !== size) throw new Error("读取期间公司行动来源变化");
    } else {
      const head = await file.read(sample, 0, sampleBytes, 0);
      const tail = await file.read(
        sample,
        sampleBytes,
        sampleBytes,
        size - sampleBytes,
      );
      if (head.bytesRead !== sampleBytes || tail.bytesRead !== sampleBytes)
        throw new Error("读取期间公司行动来源变化");
    }
    return { sample, size, modified: mtimeMs };
  } finally {
    await file.close();
  }
}

/** Concurrent readers share the full parse and SHA-256. Stat plus head/tail
 * bytes detect common rewrites without reading all records on every hit. */
export async function corporateActions(root: string) {
  const path = join(resolveTdxRoot(root), "T0002/hq_cache/gbbq");
  const statIdentity = await sourceFingerprint(path);
  const { sample, size, modified } = await sampleGbbq(path);
  if ((await sourceFingerprint(path)) !== statIdentity)
    throw new Error("读取期间公司行动来源变化");
  if (
    current?.statIdentity !== statIdentity ||
    !current.sample.equals(sample)
  ) {
    const ready = (async () => {
      const body = await readFile(path);
      const headLength = Math.min(size, sampleBytes);
      const tailLength = sample.length - headLength;
      if (
        body.length !== size ||
        !body.subarray(0, headLength).equals(sample.subarray(0, headLength)) ||
        !body.subarray(size - tailLength).equals(sample.subarray(headLength)) ||
        (await sourceFingerprint(path)) !== statIdentity
      )
        throw new Error("读取期间公司行动来源变化");
      const { events, sourceSha256 } = parseGbbqFile(body);
      return {
        events,
        modified,
        path,
        fingerprint: `${statIdentity}:${sourceSha256}`,
      };
    })();
    current = { statIdentity, sample, ready };
  }
  const entry = current;
  try {
    return { ...(await entry.ready) };
  } catch (error) {
    if (current === entry) current = undefined;
    throw error;
  }
}
