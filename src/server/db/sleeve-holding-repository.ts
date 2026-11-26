import { big, toNumber } from "trading-strategy-core/money";
import { z } from "zod";
import {
  accountKeySchema,
  type AccountKey,
} from "./account-risk-state-repository";
import { sqlite } from "./index";

const ownerSchema = accountKeySchema.extend({
  ownerKind: z.enum(["deployment", "manual", "legacy_unknown"]),
  ownerId: z.string().trim().min(1),
});
const keySchema = ownerSchema.extend({ symbol: z.string().trim().min(1) });
const price = z.number().finite().positive();
const timestamp = z.number().int().safe().default(Date.now);
const holdingSchema = keySchema.extend({
  quantity: z.number().finite().nonnegative(),
  avgEntryPrice: price.nullable(),
  entryDate: z.string().date().nullable(),
  reservedCash: z.number().finite().nonnegative().default(0),
  updatedAt: timestamp,
});
export type SleeveHolding = z.output<typeof holdingSchema>;
const deltaSchema = keySchema.extend({
  quantityDelta: z
    .number()
    .finite()
    .refine((n) => n !== 0),
  fillPrice: price,
  tradeDate: z.string().date(),
  updatedAt: timestamp,
});
type SleeveKey = z.infer<typeof keySchema>;
type OwnerKey = z.infer<typeof ownerSchema>;

const columns = `account_scope AS accountScope,account_id AS accountId,owner_kind AS ownerKind,
  owner_id AS ownerId,symbol,quantity,avg_entry_price AS avgEntryPrice,entry_date AS entryDate,
  reserved_cash AS reservedCash,updated_at AS updatedAt`;
const accountFilter = "account_scope=@accountScope AND account_id=@accountId";
const ownerFilter = `${accountFilter} AND owner_kind=@ownerKind AND owner_id=@ownerId`;
const keyFilter = `${ownerFilter} AND symbol=@symbol`;

export function listAccountSleeveHoldings(account: AccountKey, db = sqlite()) {
  return db
    .prepare<AccountKey, SleeveHolding>(
      `SELECT ${columns} FROM account_sleeve_holdings
    WHERE ${accountFilter} ORDER BY symbol,owner_kind,owner_id`,
    )
    .all(accountKeySchema.parse(account));
}

export function listOwnerSleeveHoldings(owner: OwnerKey, db = sqlite()) {
  return db
    .prepare<OwnerKey, SleeveHolding>(
      `SELECT ${columns} FROM account_sleeve_holdings
    WHERE ${ownerFilter} ORDER BY symbol`,
    )
    .all(ownerSchema.parse(owner));
}

export function upsertSleeveHolding(
  input: z.input<typeof holdingSchema>,
  db = sqlite(),
) {
  return db
    .prepare<SleeveHolding, SleeveHolding>(
      `INSERT INTO account_sleeve_holdings
    (account_scope,account_id,owner_kind,owner_id,symbol,quantity,avg_entry_price,entry_date,reserved_cash,updated_at)
    VALUES (@accountScope,@accountId,@ownerKind,@ownerId,@symbol,@quantity,@avgEntryPrice,@entryDate,@reservedCash,@updatedAt)
    ON CONFLICT(account_scope,account_id,owner_kind,owner_id,symbol) DO UPDATE SET
    quantity=excluded.quantity,avg_entry_price=excluded.avg_entry_price,entry_date=excluded.entry_date,
    reserved_cash=excluded.reserved_cash,updated_at=excluded.updated_at RETURNING ${columns}`,
    )
    .get(holdingSchema.parse(input))!;
}

export function deleteZeroSleeveHolding(key: SleeveKey, db = sqlite()) {
  return (
    db
      .prepare(
        `DELETE FROM account_sleeve_holdings WHERE ${keyFilter} AND quantity=0 AND reserved_cash=0`,
      )
      .run(keySchema.parse(key)).changes === 1
  );
}

/** Signed filled quantity. A surrounding transaction can record the unique fill and apply its delta atomically. */
export function syncSleeveHoldingDelta(
  input: z.input<typeof deltaSchema>,
  db = sqlite(),
): SleeveHolding | null {
  const fill = deltaSchema.parse(input);
  return db
    .transaction(() => {
      const prior = db
        .prepare<SleeveKey, SleeveHolding>(
          `SELECT ${columns} FROM account_sleeve_holdings WHERE ${keyFilter}`,
        )
        .get(fill);
      const previousQty = prior?.quantity ?? 0;
      const quantity = toNumber(big(previousQty).plus(fill.quantityDelta));
      if (quantity < 0) throw new Error("成交数量超过该分仓持仓");
      let avgEntryPrice = prior?.avgEntryPrice ?? null;
      let entryDate = prior?.entryDate ?? null;
      if (quantity === 0) {
        avgEntryPrice = null;
        entryDate = null;
      } else if (previousQty === 0) {
        avgEntryPrice = fill.fillPrice;
        entryDate = fill.tradeDate;
      } else if (fill.quantityDelta > 0 && avgEntryPrice !== null) {
        avgEntryPrice = toNumber(
          big(previousQty)
            .times(avgEntryPrice)
            .plus(big(fill.quantityDelta).times(fill.fillPrice))
            .div(quantity),
        );
      }
      const holding = upsertSleeveHolding(
        {
          ...fill,
          quantity,
          avgEntryPrice,
          entryDate,
          reservedCash: prior?.reservedCash ?? 0,
        },
        db,
      );
      return quantity === 0 && deleteZeroSleeveHolding(fill, db)
        ? null
        : holding;
    })
    .immediate();
}
