import { expect, it } from "vitest";
import {
  emptyDeliveryDraft,
  restoreDeliveryDraft,
} from "../../src/lib/portfolio/delivery-draft";
it("restores configuration and pending identity without executable tokens or raw evidence", () => {
  const restored = restoreDeliveryDraft(
    JSON.stringify({
      directory: "C:/fixture",
      draft: {
        ...emptyDeliveryDraft,
        account: "账户",
        path: "C:/fixture/a.csv",
      },
      pending: {
        account: "账户",
        hash: "a".repeat(64),
        source: "generic",
        scope: "all",
        token: "old-token",
      },
      rawRows: [["sensitive"]],
      token: "old-token",
    }),
  );
  expect(restored?.pending?.account).toBe("账户");
  expect(JSON.stringify(restored)).not.toContain("old-token");
  expect(JSON.stringify(restored)).not.toContain("sensitive");
});
it("rejects malformed or incomplete session state instead of enabling an old confirmation", () => {
  expect(restoreDeliveryDraft("broken")).toBeNull();
  expect(
    restoreDeliveryDraft(
      JSON.stringify({
        directory: "",
        draft: emptyDeliveryDraft,
        pending: { account: "账户", hash: "invalid" },
      }),
    ),
  ).toBeNull();
});
