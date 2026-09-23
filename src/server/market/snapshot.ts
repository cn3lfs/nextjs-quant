import type { MarketSource } from "~/lib/market/market-source";
import type { Period, Snapshot } from "~/lib/domain";
import { settings } from "../infra/settings";
import { runWorker } from "../jobs/jobs";
import { preferredOnlineChart } from "./preferred-online-chart";
import { securityDirectory } from "./securities";
import { get, put } from "../db";

export async function snapshot(
  symbol: string,
  period: Period,
  source: MarketSource | "mcp" | "online" = settings().marketDataSource,
) {
  if (source === "mcp")
    throw new Error("原 MCP 监控已停用，请重新选择免费数据源");
  const selected = source === "online" ? "auto" : source;
  let result: Snapshot;
  if (selected === "local" || selected === "auto") {
    try {
      result = await runWorker<Snapshot>({
        type: "snapshot",
        root: settings().tdxRoot,
        symbol,
        period,
      });
    } catch (error) {
      if (selected === "local") throw error;
      result = await preferredOnlineChart(symbol, period);
      result.sourceNote = `本地源不可用，已换在线源；${result.sourceNote ?? ""}`;
    }
  } else result = await preferredOnlineChart(symbol, period, selected);
  // Selection belongs to this request, not to a previously cached snapshot.
  result = {
    ...result,
    requestedSource: selected,
    id: `${result.id}-${selected}`,
  };
  const existing = get<Snapshot>(result.id);
  if (!existing) put("snapshot", result.id, result);
  const profile = (await securityDirectory()).entries[symbol];
  return {
    ...(existing ?? result),
    name: profile?.name ?? result.name ?? existing?.name,
  };
}
