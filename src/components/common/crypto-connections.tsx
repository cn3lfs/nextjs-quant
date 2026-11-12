"use client";
import { useState } from "react";
import Link from "next/link";
import { Globe } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { GridTable, Panel } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
type Probe = { ok: boolean; status?: number; ms: number; message: string };
const ProbeCell = ({ value }: { value: Probe | null }) =>
  value === null ? (
    <span className="text-nc-text-4">未配置代理</span>
  ) : (
    <span className={value.ok ? "nc-text-ok" : "nc-text-bad"}>
      {value.message}
      <span className="text-nc-text-4"> · {value.ms}ms</span>
    </span>
  );

/**
 * 数字货币 connections: the outbound proxy used when a direct connection
 * fails and a live reachability check. Trading credentials belong to /crypto. Kept
 * apart from the A-share data settings above.
 */
export function CryptoConnections() {
  const utils = api.useUtils();
  const current = api.cryptoSettings.useQuery();
  const [proxyDraft, setProxyDraft] = useState<string | null>(null);
  const proxy = proxyDraft ?? current.data?.outboundProxy ?? "";
  const saveProxy = api.saveCryptoSettings.useMutation({
    onSuccess: () => {
      setProxyDraft(null);
      void utils.cryptoSettings.invalidate();
    },
  });
  const check = api.cryptoConnectivity.useMutation();
  return (
    <>
      <Panel
        span={6}
        icon={Globe}
        title="数字货币出站代理"
        tag="仅数字货币"
        note="外网请求先直连（3 秒内连上即用），失败再走这里的代理；每个网站记住能用的路线 10 分钟。支持 socks5:// 和 http://，留空表示只直连。A 股数据源不经过这里。"
      >
        <div className="inline-form">
          <label className="flex min-w-0 flex-1 flex-col gap-[5px] text-[11px] text-nc-text-3">
            代理地址
            <Input
              aria-label="数字货币出站代理"
              value={proxy}
              placeholder="socks5://127.0.0.1:10808"
              onChange={(event) => setProxyDraft(event.target.value)}
            />
          </label>
          <Button
            disabled={saveProxy.isPending || !current.data}
            onClick={() =>
              current.data &&
              saveProxy.mutate({
                outboundProxy: proxy,
                binanceTestnet: current.data.binanceTestnet,
              })
            }
          >
            保存
          </Button>
          <Button
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate({ proxy })}
          >
            {check.isPending ? "测试中…" : "测试连通性"}
          </Button>
        </div>
        {saveProxy.error && (
          <p role="alert" className="nc-text-bad">
            {saveProxy.error.message}
          </p>
        )}
        {check.data && (
          <GridTable
            label="连通性"
            rows={check.data.rows}
            rowKey={(row) => row.host}
            columns={[
              {
                key: "host",
                header: "地址",
                width: "1.4fr",
                cell: (row) => (
                  <div className="flex min-w-0 flex-col">
                    <strong className="truncate font-medium">{row.host}</strong>
                    <span className="text-[10.5px] text-nc-text-4">
                      {row.use}
                    </span>
                  </div>
                ),
              },
              {
                key: "direct",
                header: "直连",
                cell: (row) => <ProbeCell value={row.direct} />,
              },
              {
                key: "proxy",
                header: "经代理",
                cell: (row) => <ProbeCell value={row.proxy} />,
              },
            ]}
          />
        )}
        {check.error && (
          <p role="alert" className="nc-text-bad">
            {check.error.message}
          </p>
        )}
      </Panel>
      <Panel
        span={6}
        icon={Globe}
        title="模拟自动交易账户"
        note="币安、OKX、Bybit 的模拟账户凭证与双均线策略统一在数字货币页面管理。"
      >
        <Link href="/crypto" className="underline">
          打开数字货币模拟自动交易
        </Link>
      </Panel>
    </>
  );
}
