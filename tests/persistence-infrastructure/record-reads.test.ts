import Database from "better-sqlite3";
import { beforeEach, expect, it } from "vitest";
import { join } from "node:path";
import {
  dataDirectory,
  list,
  readRecordSnapshot,
  recordPage,
  sqlite,
  type RecordCursor,
} from "~/server/db";

type Row = { id: string; value: number };
const id = (value: number) => `record-${String(value).padStart(4, "0")}`;
function seed(count: number) {
  const insert = sqlite().prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES (?, 'read-test', ?, 10)",
  );
  sqlite().transaction(() => {
    for (let value = 0; value < count; value++)
      insert.run(id(value), JSON.stringify({ id: id(value), value }));
  })();
}
beforeEach(() => sqlite().prepare("DELETE FROM records").run());

it.each([0, 1, 200, 201, 1001])(
  "reads %i records without omissions or duplicates",
  (count) => {
    seed(count);
    const rows: Row[] = [];
    let cursor: RecordCursor | undefined;
    do {
      const page = recordPage<Row>("read-test", 200, cursor);
      expect(page.items.length).toBeLessThanOrEqual(200);
      rows.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(rows.map((row) => row.value)).toEqual(
      Array.from({ length: count }, (_, i) => i),
    );
    expect(
      readRecordSnapshot("read-test", (records: Iterable<Row>) => [...records]),
    ).toEqual(rows);
  },
);

it("requires explicit bounded limits and rejects cross-kind cursors", () => {
  for (const limit of [undefined, -1, 0, 1.5, NaN, Infinity, 1001]) {
    expect(() => list("read-test", limit as number)).toThrow(/1–1000/);
    expect(() => recordPage("read-test", limit as number)).toThrow(/1–1000/);
  }
  expect(() =>
    recordPage("read-test", 200, { kind: "other", id: "a" }),
  ).toThrow(/游标/);
});

it("recent lists use a deterministic ID tie-breaker and remain explicitly limited", () => {
  seed(201);
  const recent = list<Row>("read-test", 200);
  expect(recent).toHaveLength(200);
  expect(recent.map((row) => row.value)).toEqual(
    Array.from({ length: 200 }, (_, i) => 200 - i),
  );
  sqlite().prepare("UPDATE records SET updated_at=20 WHERE id=?").run(id(0));
  expect(list<Row>("read-test", 1)[0]!.value).toBe(0);
});

it("freezes values and membership across batch boundaries while another connection writes", () => {
  seed(401);
  const writer = new Database(join(dataDirectory(), "quant.sqlite"));
  try {
    const rows = readRecordSnapshot("read-test", (records: Iterable<Row>) => {
      const result: Row[] = [];
      for (const row of records) {
        result.push(row);
        if (result.length === 200) {
          writer.transaction(() => {
            writer.prepare("DELETE FROM records WHERE id=?").run(id(200));
            writer
              .prepare("UPDATE records SET payload=?,updated_at=30 WHERE id=?")
              .run(JSON.stringify({ id: id(201), value: -1 }), id(201));
            writer
              .prepare("INSERT INTO records VALUES (?, 'read-test', ?, 40)")
              .run(id(401), JSON.stringify({ id: id(401), value: 401 }));
          })();
        }
      }
      return result;
    });
    expect(rows.map((row) => row.value)).toEqual(
      Array.from({ length: 401 }, (_, i) => i),
    );
    const next = readRecordSnapshot("read-test", (records: Iterable<Row>) => [
      ...records,
    ]);
    expect(next).toHaveLength(401);
    expect(next.find((row) => row.id === id(200))).toBeUndefined();
    expect(next.find((row) => row.id === id(201))!.value).toBe(-1);
    expect(next.at(-1)!.value).toBe(401);
  } finally {
    writer.close();
  }
});

it("closes snapshots after errors or early return and rejects deferred consumption", () => {
  seed(201);
  expect(() =>
    readRecordSnapshot("read-test", () => {
      throw new Error("read failed");
    }),
  ).toThrow("read failed");
  expect(sqlite().inTransaction).toBe(false);
  const escaped = readRecordSnapshot("read-test", (records: Iterable<Row>) =>
    records[Symbol.iterator](),
  );
  expect(() => escaped.next()).toThrow("快照已关闭");
  expect(() =>
    readRecordSnapshot("read-test", () => Promise.resolve(1)),
  ).toThrow("同步读取");
  expect(
    readRecordSnapshot("read-test", (records: Iterable<Row>) => {
      for (const row of records) return row.value;
    }),
  ).toBe(0);
  expect(sqlite().inTransaction).toBe(false);
});

it("propagates validation failures in later batches instead of returning partial totals", () => {
  seed(201);
  sqlite()
    .prepare("UPDATE records SET payload=? WHERE id=?")
    .run(JSON.stringify({ id: id(200), value: "broken" }), id(200));
  expect(() =>
    readRecordSnapshot("read-test", (records: Iterable<Row>) => {
      let total = 0;
      for (const row of records) {
        if (typeof row.value !== "number") throw new Error("invalid value");
        total += row.value;
      }
      return total;
    }),
  ).toThrow("invalid value");
  expect(sqlite().inTransaction).toBe(false);
});
