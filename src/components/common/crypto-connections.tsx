"use client";
import { useState } from "react";
import { CurrencyBtc, Globe, Key } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { GridTable, Panel, Pill } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const networkLabels = {
  demo: "Demo 模拟盘",
  testnet: "测试网",
  live: "实盘 Key（模拟盘不使用，请重新保存）",
} as const;

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
 * fails, a live reachability check, and the Binance API key (DPAPI). Kept
 * apart from the A-share data settings above.
 */
export function CryptoConnections() {
  const utils = api.useUtils();
  const current = api.cryptoSettings.useQuery();
  const credential = api.binanceCredentialStatus.useQuery();
  const [proxyDraft, setProxyDraft] = useState<string | null>(null);
  const proxy = proxyDraft ?? current.data?.outboundProxy ?? "";
  const saveProxy = api.saveCryptoSettings.useMutation({
    onSuccess: () => {
      setProxyDraft(null);
      void utils.cryptoSettings.invalidate();
    },
  });
  const check = api.cryptoConnectivity.useMutation();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [network, setNetwork] = useState<"demo" | "testnet">("demo");
  const [clearing, setClearing] = useState(false);
  const refreshCredential = () =>
    void utils.binanceCredentialStatus.invalidate();
  const saveKey = api.saveBinanceCredential.useMutation({
    onSuccess: () => {
      setApiKey("");
      setApiSecret("");
      refreshCredential();
    },
  });
  const clearKey = api.clearBinanceCredential.useMutation({
    onSuccess: () => {
      setClearing(false);
      refreshCredential();
    },
  });
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
        icon={Key}
        title="币安 API"
        actions={
          credential.data?.configured ? (
            <Pill tone={credential.data.network === "live" ? "warn" : "accent"}>
              已配置 {credential.data.keyHint} ·{" "}
              {networkLabels[credential.data.network]}
            </Pill>
          ) : (
            <Pill tone="idle">未配置</Pill>
          )
        }
        note="只接受模拟盘 Key：Demo Key 在币安账户的 Demo Trading → API 管理创建，测试网 Key 在 testnet.binance.vision 用 GitHub 登录生成；两种 Key 不能互用，也不接受实盘 Key。Key 与 Secret 用 Windows DPAPI 加密保存在本机，界面只显示末 4 位。应用不会自动下单。"
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            saveKey.mutate({ apiKey, apiSecret, network });
          }}
        >
          <label>
            API Key
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label>
            Secret Key
            <Input
              type="password"
              autoComplete="new-password"
              value={apiSecret}
              onChange={(event) => setApiSecret(event.target.value)}
            />
          </label>
          <label className="col-span-full">
            Key 所属网络
            <Select
              value={network}
              onValueChange={(value) => setNetwork(value as typeof network)}
            >
              <SelectTrigger aria-label="Key 所属网络">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="demo">
                  Demo 模拟盘（demo-api.binance.com，贴近实盘行情）
                </SelectItem>
                <SelectItem value="testnet">
                  现货测试网（testnet.binance.vision，独立行情）
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
          <div className="button-row col-span-full">
            <Button
              type="submit"
              disabled={!apiKey || !apiSecret || saveKey.isPending}
            >
              <CurrencyBtc size={14} />
              保存 Key
            </Button>
            {credential.data?.configured &&
              (clearing ? (
                <>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={clearKey.isPending}
                    onClick={() => clearKey.mutate()}
                  >
                    确认删除已保存的 Key
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setClearing(false)}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setClearing(true)}
                >
                  删除 Key
                </Button>
              ))}
          </div>
        </form>
        {(saveKey.error || clearKey.error || credential.error) && (
          <p role="alert" className="nc-text-bad">
            {saveKey.error?.message ??
              clearKey.error?.message ??
              credential.error?.message}
          </p>
        )}
      </Panel>
    </>
  );
}
