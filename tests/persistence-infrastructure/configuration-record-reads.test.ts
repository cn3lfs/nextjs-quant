import { beforeEach, expect, it } from "vitest";
import { createCaller } from "~/server/api/root";
import { savedFormulas } from "~/server/screening/formula-screen-service";
import { sqlite } from "~/server/db";

beforeEach(() => sqlite().prepare("DELETE FROM records").run());

it("returns all channel and monitor definitions beyond 200, and saved formulas beyond 1000", async () => {
  const insert = sqlite().prepare("INSERT INTO records VALUES (?,?,?,?)");
  sqlite().transaction(() => {
    for (const [kind, count] of [
      ["channel", 201],
      ["monitor", 201],
      ["tdx-formula", 1001],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const id = `${kind}-${String(i).padStart(4, "0")}`;
        insert.run(id, kind, JSON.stringify({ id, name: id, updatedAt: i }), i);
      }
    }
  })();
  const caller = createCaller({ headers: new Headers() });
  expect(await caller.channels()).toHaveLength(201);
  expect(await caller.monitors()).toHaveLength(201);
  const formulas = savedFormulas();
  expect(formulas).toHaveLength(1001);
  expect(formulas[0]!.id).toBe("tdx-formula-1000");
  expect(formulas.at(-1)!.id).toBe("tdx-formula-0000");
});
