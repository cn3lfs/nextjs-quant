import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

// This is a corruption/change detector for local derived data, not an
// authentication boundary. Hash a complete generation strongly on first use;
// thereafter CRC every byte, including when Windows retains all timestamps.
// Only tiny identities are retained, never source buffers or mutable Bars.
const generations = new Map<string, { checksum: number; digest: string }>();
export function contentDigest(identity: string, body: Buffer) {
  const checksum = crc32(body);
  const known = generations.get(identity);
  if (known?.checksum === checksum) return known.digest;
  const digest = createHash("sha256").update(body).digest("hex");
  if (generations.size >= 32768) generations.clear();
  generations.set(identity, { checksum, digest });
  return digest;
}
