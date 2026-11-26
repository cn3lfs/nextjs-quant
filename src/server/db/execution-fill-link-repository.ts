import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountKeySchema,
  type AccountKey,
} from "./account-risk-state-repository";
import { sqlite } from "./index";

const id = z.string().trim().min(1);
const linkSchema = accountKeySchema.extend({
  id: id.default(randomUUID),
  intentId: id.nullable().default(null),
  rebalancePlanId: id.nullable().default(null),
  venueOrderId: id.nullable().default(null),
  fillSource: z.enum([
    "sim_fills",
    "paper_fills",
    "real_fills",
    "futures_sim",
    "ths_mock",
    "crypto_sim",
  ]),
  fillId: id,
  arrivalPrice: z.number().finite().positive().nullable().default(null),
  createdAt: z.number().int().safe().default(Date.now),
});
export type ExecutionFillLink = z.output<typeof linkSchema>;

const selectLinks = `SELECT id,intent_id AS intentId,rebalance_plan_id AS rebalancePlanId,
  account_scope AS accountScope,account_id AS accountId,venue_order_id AS venueOrderId,
  fill_source AS fillSource,fill_id AS fillId,arrival_price AS arrivalPrice,created_at AS createdAt
  FROM execution_fill_links`;
const order = "ORDER BY created_at DESC,id";

export function recordExecutionFillLink(
  input: z.input<typeof linkSchema>,
  db = sqlite(),
) {
  return (
    db
      .prepare(
        `INSERT INTO execution_fill_links (id,intent_id,rebalance_plan_id,account_scope,
    account_id,venue_order_id,fill_source,fill_id,arrival_price,created_at)
    VALUES (@id,@intentId,@rebalancePlanId,@accountScope,@accountId,@venueOrderId,@fillSource,@fillId,@arrivalPrice,@createdAt)
    ON CONFLICT(fill_source,fill_id) DO NOTHING`,
      )
      .run(linkSchema.parse(input)).changes === 1
  );
}

export function listFillLinksByIntentIds(
  intentIds: readonly string[],
  db = sqlite(),
) {
  return db
    .prepare<[string], ExecutionFillLink>(
      `${selectLinks} WHERE intent_id IN (SELECT value FROM json_each(?)) ${order}`,
    )
    .all(JSON.stringify(intentIds));
}

export function listFillLinksByPlanId(planId: string, db = sqlite()) {
  return db
    .prepare<[string], ExecutionFillLink>(
      `${selectLinks} WHERE rebalance_plan_id=? ${order}`,
    )
    .all(planId);
}

export function listFillLinksByAccount(account: AccountKey, db = sqlite()) {
  return db
    .prepare<AccountKey, ExecutionFillLink>(
      `${selectLinks} WHERE account_scope=@accountScope
    AND account_id=@accountId ${order}`,
    )
    .all(accountKeySchema.parse(account));
}
