import { describe, expect, it } from "vitest";
import {
  deliveryOutcomeCounts,
  deliveryPageSchema,
  monitorPageSchema,
  monitorRetrySchema,
  signalPageSchema,
} from "../../../src/lib/strategy-facts/monitor-workspace";

describe("monitor workspace read and explicit-action contracts", () => {
  it("normalizes submitted text but rejects impossible dates and invalid cursors", () => {
    expect(
      signalPageSchema.parse({ query: "  中国  ", from: "2024-02-29" }),
    ).toEqual({ query: "中国", from: "2024-02-29" });
    for (const from of ["2026-02-29", "2026-13-01", "2026-04-31"])
      expect(signalPageSchema.safeParse({ from }).success).toBe(false);
    expect(
      deliveryPageSchema.safeParse({ from: "2026-09-30", to: "2026-09-29" })
        .success,
    ).toBe(false);
    expect(
      monitorPageSchema.safeParse({ cursor: "x".repeat(2049) }).success,
    ).toBe(false);
    expect(monitorPageSchema.parse({ enabled: false }).enabled).toBe(false);
  });
  it("keeps all channel and retry outcomes, including failed originals", () => {
    const rows = [
      { status: "failed" },
      { status: "sent" },
      { status: "pending" },
      { status: "sent" },
    ] as const;
    expect(deliveryOutcomeCounts(rows)).toEqual({
      failed: 1,
      sent: 2,
      pending: 1,
      sending: 0,
      expired: 0,
      cancelled: 0,
    });
    // A first-match implementation is a known violating input for this mixed-state case.
    expect(deliveryOutcomeCounts(rows.slice(0, 1))).not.toEqual(
      deliveryOutcomeCounts(rows),
    );
  });
  it("requires an explicit delivery identity and a stable confirmation request identity", () => {
    const action = {
      deliveryId: "delivery-fixture",
      requestId: "83a849d0-e17a-4cfe-b3f4-c0e47c9b8401",
    };
    expect(monitorRetrySchema.parse(action)).toEqual(action);
    expect(
      monitorRetrySchema.safeParse({ deliveryId: action.deliveryId }).success,
    ).toBe(false);
    expect(
      monitorRetrySchema.safeParse({ ...action, deliveryId: "" }).success,
    ).toBe(false);
  });
});
