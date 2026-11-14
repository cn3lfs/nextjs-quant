import { sqlite } from "./index";
import { readSnapshot } from "./snapshot";
import type { Execution } from "../crypto-trading/model";
export function cryptoOrders(id: string): Execution[] {
  // Recovery must see every unresolved intent, not a UI history limit.
  return readSnapshot(() =>
    Array.from(
      sqlite()
        .prepare(
          "SELECT payload FROM records WHERE kind=? ORDER BY updated_at ASC, id ASC",
        )
        .iterate(`crypto-orders-${id}`) as Iterable<{ payload: string }>,
      (row) => JSON.parse(row.payload) as Execution,
    ),
  );
}
