import type { Snapshot } from "~/lib/domain";
import { packedSnapshotBars } from "./screen-wire";

const fields = ["open", "high", "low", "close", "volume", "amount"] as const;
function canonicalBar(bar: Snapshot["bars"][number]) {
  if (!bar) return false;
  const keys = Object.keys(bar);
  return (
    keys.length === 7 &&
    keys[0] === "date" &&
    keys[1] === "open" &&
    keys[2] === "high" &&
    keys[3] === "low" &&
    keys[4] === "close" &&
    keys[5] === "volume" &&
    keys[6] === "amount" &&
    typeof bar.date === "string"
  );
}
type Entry = {
  metadata: string;
  dates: string[];
  values: Float64Array;
  json: string;
  bytes: number;
};

/** Content comparison is deliberate: IDs and supplied hashes are not proof of equality. */
export class SnapshotSerializer {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly limit = 256 * 1024 * 1024) {}

  stringify(snapshot: Snapshot): string {
    const packed = packedSnapshotBars(snapshot);
    if (packed) {
      const old = this.entries.get(snapshot.id);
      const metadata = JSON.stringify([
        Object.keys(snapshot),
        Object.fromEntries(
          Object.keys(snapshot)
            .filter((key) => key !== "bars")
            .map((key) => [key, snapshot[key as keyof Snapshot]]),
        ),
      ]);
      let same =
        !!old && old.metadata === metadata && old.dates.length === packed.count;
      if (same)
        for (let i = 0; i < packed.count; i++) {
          const row = packed.offset + i;
          if (old!.dates[i] !== packed.dates[packed.dateIndexes[row]!]) {
            same = false;
            break;
          }
          for (let j = 0; j < 6; j++) {
            if (
              !Object.is(old!.values[i * 6 + j], packed.values[row * 6 + j])
            ) {
              same = false;
              break;
            }
          }
          if (!same) break;
        }
      if (same && old) {
        this.entries.delete(snapshot.id);
        this.entries.set(snapshot.id, old);
        return old.json;
      }
    }
    const { bars, ...rest } = snapshot;
    const metadata = JSON.stringify([Object.keys(snapshot), rest]);
    const old = this.entries.get(snapshot.id);
    let supported = Array.isArray(bars);
    let same =
      supported &&
      !!old &&
      old.metadata === metadata &&
      old.dates.length === bars.length;
    if (same)
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i]!;
        if (!canonicalBar(bar)) {
          supported = false;
          break;
        }
        const offset = i * 6,
          values = old!.values;
        same =
          bar.date === old!.dates[i] &&
          Object.is(bar.open, values[offset]) &&
          Object.is(bar.high, values[offset + 1]) &&
          Object.is(bar.low, values[offset + 2]) &&
          Object.is(bar.close, values[offset + 3]) &&
          Object.is(bar.volume, values[offset + 4]) &&
          Object.is(bar.amount, values[offset + 5]);
        if (!same) break;
      }
    if (supported && same && old) {
      this.entries.delete(snapshot.id);
      this.entries.set(snapshot.id, old);
      return old.json;
    }
    if (old) {
      this.bytes -= old.bytes;
      this.entries.delete(snapshot.id);
    }
    const json = JSON.stringify(snapshot);
    if (!supported) return json;
    let size = json.length * 2 + bars.length * 48 + metadata.length * 2 + 128;
    if (size > this.limit) return json;
    const values = new Float64Array(bars.length * 6);
    const dates: string[] = [];
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      if (!canonicalBar(bar)) return json;
      size += bar.date.length * 2 + 8;
      if (size > this.limit) return json;
      dates.push(bar.date);
      for (let j = 0; j < fields.length; j++) {
        const field = fields[j]!,
          value = bar[field];
        if (!Object.hasOwn(bar, field) || !Number.isFinite(value)) return json;
        values[i * 6 + j] = value;
      }
    }
    while (this.entries.size && this.bytes + size > this.limit) {
      const key = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(key)!.bytes;
      this.entries.delete(key);
    }
    this.entries.set(snapshot.id, {
      metadata,
      dates,
      values,
      json,
      bytes: size,
    });
    this.bytes += size;
    return json;
  }
}
const serializer = new SnapshotSerializer();
export const serializeSnapshot = (snapshot: Snapshot) =>
  serializer.stringify(snapshot);
