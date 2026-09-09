import { expect, it, vi } from "vitest";
import { PrioritySlots } from "../src/server/priority-slots";
it("interactive work overtakes queued batches and release is idempotent", async () => {
  const slots = new PrioritySlots(1),
    release = await slots.acquire();
  const order: string[] = [];
  const batch = slots.acquire(0).then((done) => {
    order.push("batch");
    return done;
  });
  const interactive = slots.acquire(1).then((done) => {
    order.push("interactive");
    return done;
  });
  release();
  release();
  const done = await interactive;
  expect(order).toEqual(["interactive"]);
  done();
  (await batch)();
  expect(order).toEqual(["interactive", "batch"]);
});
it("queued cancellation rejects immediately without waiting for a busy slot", async () => {
  const slots = new PrioritySlots(1),
    release = await slots.acquire();
  const controller = new AbortController();
  const waiting = slots.acquire(0, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow("取消");
  release();
  (await slots.acquire())();
});
it("aging allows an older batch ahead of newly queued interactive work", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100000);
  try {
    const slots = new PrioritySlots(1),
      release = await slots.acquire(),
      order: string[] = [];
    const batch = slots.acquire(0).then((done) => {
      order.push("batch");
      return done;
    });
    now.mockReturnValue(161000);
    const interactive = slots.acquire(1).then((done) => {
      order.push("interactive");
      return done;
    });
    release();
    (await batch)();
    (await interactive)();
    expect(order).toEqual(["batch", "interactive"]);
  } finally {
    now.mockRestore();
  }
});
