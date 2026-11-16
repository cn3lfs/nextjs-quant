import type Database from "better-sqlite3";
import { sqlite } from "./index";
import type { HoldingProtectionBinding } from "~/lib/portfolio/holding-protection";

export class HoldingProtectionRepository {
  constructor(readonly db: Database.Database = sqlite()) {}
  all() {
    return (
      this.db
        .prepare(
          "SELECT payload FROM account_protections ORDER BY kind,account,market,symbol",
        )
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as HoldingProtectionBinding);
  }
  get(id: string) {
    const row = this.db
      .prepare("SELECT payload FROM account_protections WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as HoldingProtectionBinding) : null;
  }
  save(binding: HoldingProtectionBinding) {
    this.db
      .prepare(
        `INSERT INTO account_protections(id,kind,account,market,symbol,strategy_id,strategy_version,plan_id,payload)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET strategy_id=excluded.strategy_id,strategy_version=excluded.strategy_version,plan_id=excluded.plan_id,payload=excluded.payload`,
      )
      .run(
        binding.id,
        binding.kind,
        binding.account,
        binding.market,
        binding.symbol,
        binding.strategyId,
        binding.version,
        binding.planId,
        JSON.stringify(binding),
      );
    return binding;
  }
}
