"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { TradingStatusEvidence } from "./trading-status-evidence";
const sources = {
  "tdx-tnf": "通达信本地 TNF 名称资料",
  tencent: "腾讯身份检索",
  hithink: "问财基础资料",
};
const markets: Record<string, string> = { sh: "上海", sz: "深圳", bj: "北京" };
export function SecurityProfilePanel({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  const utils = api.useUtils();
  const verify = api.verifySecurityLifecycle.useMutation({
    onSuccess: () => utils.securityProfile.invalidate(symbol),
  });
  const verifyStatus = api.verifySecurityTradingStatus.useMutation({
    onSuccess: () => utils.securityProfile.invalidate(symbol),
  });
  const query = api.securityProfile.useQuery(symbol, {
    enabled: open,
    staleTime: 60000,
  });
  const profile = query.data?.profile;
  const lifecycle = query.data?.lifecycle;
  return (
    <details
      className="notice"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>证券主档与名称来源</summary>
      {query.isLoading && <p role="status">正在读取证券主档…</p>}
      {query.error && (
        <p role="alert">
          主档读取失败：{query.error.message}
          <Button onClick={() => void query.refetch()}>重试主档</Button>
        </p>
      )}
      {query.isSuccess && !profile && (
        <p>
          未取得该品种证券主档资料，名称待补全；不会根据行情文件或模型文本猜测证券身份。
        </p>
      )}
      {profile && (
        <>
          <p>
            {profile.name} · {profile.symbol.toUpperCase()} ·{" "}
            {markets[profile.market] ?? profile.market} · {profile.type} ·{" "}
            {profile.currency}
          </p>
          <p>名称来源：{sources[profile.nameSource]}</p>
          <p>
            历史名称/别名：
            {profile.aliases.length ? profile.aliases.join("、") : "暂无记录"}
          </p>
          <p>
            名称记录时间：{new Date(profile.updatedAt).toLocaleString("zh-CN")}
          </p>
        </>
      )}
      {query.isSuccess && (
        <>
          <p>
            上市日期：
            {lifecycle?.listingDate ?? "未取得"} · 退市日期：
            {lifecycle?.delistingDate ?? "未取得"}
          </p>
          <Button
            disabled={verify.isPending}
            onClick={() => verify.mutate(symbol)}
          >
            {verify.isPending ? "核验上市资料中…" : "核验上市/退市资料"}
          </Button>
          {verify.error && (
            <p role="alert">上市资料核验失败：{verify.error.message}</p>
          )}
          {lifecycle && (
            <>
              <p>
                日期来源：{lifecycle.source} · 查询时间：
                {new Date(lifecycle.fetchedAt).toLocaleString("zh-CN")}
              </p>
              {lifecycle.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              <details>
                <summary>查看日期核验证据</summary>
                <pre>{JSON.stringify(lifecycle.evidence, null, 2)}</pre>
                <p>证据指纹：{lifecycle.evidenceHash}</p>
              </details>
            </>
          )}
          <p>
            上市资料缓存 24
            小时；查询时间不代表历史时点可知时间，日期缺失不表示未退市，上市日期也不能证明当前可交易。
          </p>
          <Button
            disabled={verifyStatus.isPending}
            onClick={() => verifyStatus.mutate(symbol)}
          >
            {verifyStatus.isPending ? "核验交易状态中…" : "核验交易状态"}
          </Button>
          {verifyStatus.error && (
            <p role="alert">交易状态核验失败：{verifyStatus.error.message}</p>
          )}
          <TradingStatusEvidence value={query.data?.tradingStatus} />
          <p>本地资料目录：{query.data?.root}</p>
          <p>
            名称资料不代表当前正常交易；双源身份核验、停复牌和行情时效分别查看对应记录。
          </p>
        </>
      )}
    </details>
  );
}
