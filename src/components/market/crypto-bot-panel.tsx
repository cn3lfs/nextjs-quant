"use client";
import { useState } from "react";
import Big from "big.js";
import { CurrencyBtc } from "@phosphor-icons/react/ssr";
import type { Config } from "~/server/crypto-trading/model";
import { api } from "~/trpc/react";
import { Panel, Pill } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { CryptoAccountPanel } from "./crypto-account-panel";
import { HoldingAlertEditor } from "../portfolio/holding-alert-editor";
import { PanelVisibility, usePanelVisible } from "../workbench/keep-alive";

const accounts = [
  ["binance-demo", "币安 Demo"],
  ["binance-testnet", "币安 Spot Testnet"],
  ["okx-demo", "OKX 模拟盘"],
  ["bybit-demo", "Bybit Demo"],
] as const;
const stateLabels = { stopped: "已停止", paused: "已暂停", running: "运行中" };
const finished = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
  "Filled",
  "Cancelled",
  "PartiallyFilledCanceled",
  "Rejected",
  "Deactivated",
  "filled",
  "canceled",
]);
const timestamp = (value: number) => new Date(value).toLocaleString();

/** Trading configuration is independent of the chart's display source and pair. */
export function CryptoBotPanel({ view }: { view: "strategy" | "account" }) {
  const [id, setId] = useState("binance-demo");
  return (
    <Panel
      icon={CurrencyBtc}
      title={view === "strategy" ? "现货策略模拟" : "平台账户与历史成交"}
      tag="BTCUSDT / ETHUSDT"
      note={
        view === "strategy"
          ? "仅在所选模拟账户运行；行情页的来源和交易对不改变策略配置。应用保持运行时，每10秒检查新收盘K线。"
          : "平台资产包含原有持仓；策略数量与平台余额分别统计。历史日期筛选使用UTC，成交时刻按本地时区显示。"
      }
    >
      <label className="flex max-w-sm flex-col gap-1 text-sm">
        模拟平台与账户
        <Select value={id} onValueChange={setId}>
          <SelectTrigger aria-label="模拟平台与账户">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accounts.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <AccountBot key={id} id={id} view={view} />
    </Panel>
  );
}

function AccountBot({
  id,
  view,
}: {
  id: string;
  view: "strategy" | "account";
}) {
  const utils = api.useUtils();
  const visible = usePanelVisible();
  const status = api.cryptoBotStatus.useQuery(id, {
    retry: false,
    refetchInterval: visible ? 10000 : false,
  });
  const bot = status.data?.bot;
  const [draft, setDraft] = useState<Config | null>(null);
  const [venue, network] = id.split("-") as [
    Config["venue"],
    Config["network"],
  ];
  const defaults: Config = {
    venue,
    network,
    minutes: 60,
    fast: 5,
    slow: 20,
    allocation: 0.4,
  };
  const config = draft ?? bot?.config ?? defaults;
  const configErrors = [
    !Number.isInteger(config.fast) || config.fast < 1 || config.fast > 199
      ? "短均线须为1至199的整数。"
      : "",
    !Number.isInteger(config.slow) || config.slow < 2 || config.slow > 200
      ? "长均线须为2至200的整数。"
      : "",
    config.fast >= config.slow ? "短均线须小于长均线。" : "",
    !Number.isFinite(config.allocation) ||
    config.allocation <= 0 ||
    config.allocation > 0.4
      ? "每币资金比例须大于0且不超过40%。"
      : "",
  ].filter(Boolean);
  const dirty = !bot || JSON.stringify(config) !== JSON.stringify(bot.config);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = () => void utils.cryptoBotStatus.invalidate(id);
  const diagnose = api.diagnoseCryptoBot.useMutation();
  const save = api.saveCryptoBot.useMutation({
    onSuccess: () => {
      setDraft(null);
      diagnose.reset();
      setNotice("策略配置已保存");
      refresh();
    },
  });
  const credential = api.saveCryptoBotCredential.useMutation({
    onSuccess: () => {
      setApiKey("");
      setApiSecret("");
      setPassphrase("");
      diagnose.reset();
      setNotice("模拟账户凭证已保存");
      void utils.cryptoAccountView.reset();
      refresh();
    },
  });
  const control = api.controlCryptoBot.useMutation({
    onSuccess: () => {
      setNotice("运行状态已更新");
      refresh();
    },
  });
  const cancel = api.cancelCryptoBotOrder.useMutation({ onSuccess: refresh });
  const pending =
    save.isPending ||
    credential.isPending ||
    control.isPending ||
    diagnose.isPending ||
    cancel.isPending;
  const running = bot?.status === "running";
  const errors = [
    status.error,
    save.error,
    credential.error,
    diagnose.error,
    control.error,
    cancel.error,
  ];
  const update = (value: Partial<Config>) => {
    setDraft({ ...config, ...value });
    diagnose.reset();
    setNotice("");
  };
  const diagnostic = diagnose.data;
  const usdt = diagnostic?.balances.find(
    (balance) => balance.asset === "USDT",
  )?.free;
  let statusLabel = "尚未配置";
  if (status.isLoading) statusLabel = "正在读取配置";
  else if (status.error) statusLabel = "配置读取失败";
  else if (bot) statusLabel = stateLabels[bot.status];
  let credentialLabel = "凭证配置状态未取得";
  if (status.data) {
    credentialLabel = status.data.credentialConfigured
      ? "模拟账户凭证已配置"
      : "尚未配置凭证";
  }
  return (
    <div className="mt-4 space-y-4 text-sm">
      <PanelVisibility visible={view === "account"}>
        <div hidden={view !== "account"}>
          {status.isLoading && <p role="status">正在读取当前账户配置…</p>}
          {status.error && (
            <div role="alert">
              {status.error.message}
              <Button variant="outline" onClick={() => void status.refetch()}>
                重试账户配置
              </Button>
            </div>
          )}
          {status.data && (
            <CryptoAccountPanel
              id={id}
              configured={status.data.credentialConfigured}
            />
          )}
        </div>
      </PanelVisibility>
      <PanelVisibility visible={view === "strategy"}>
        <div hidden={view !== "strategy"} className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Pill tone={running ? "accent" : "idle"}>{statusLabel}</Pill>
            <span>{credentialLabel}</span>
            {bot && (
              <span className="text-nc-text-4">
                更新于 {timestamp(bot.updatedAt)}
              </span>
            )}
          </div>
          <fieldset
            disabled={pending || running}
            className="grid gap-3 sm:grid-cols-4"
          >
            <label className="flex flex-col gap-1">
              K线周期
              <Select
                value={String(config.minutes)}
                disabled={pending || running}
                onValueChange={(value) =>
                  update({ minutes: value === "15" ? 15 : 60 })
                }
              >
                <SelectTrigger aria-label="策略K线周期">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="60">1小时</SelectItem>
                  <SelectItem value="15">15分钟</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              短均线 SMA
              <Input
                type="number"
                min={1}
                max={199}
                value={config.fast}
                onChange={(event) =>
                  update({ fast: Number(event.target.value) })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              长均线 SMA
              <Input
                type="number"
                min={2}
                max={200}
                value={config.slow}
                onChange={(event) =>
                  update({ slow: Number(event.target.value) })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              每币资金上限（%）
              <Input
                type="number"
                min={1}
                max={40}
                value={config.allocation * 100}
                onChange={(event) =>
                  update({ allocation: Number(event.target.value) / 100 })
                }
              />
            </label>
            <div className="sm:col-span-4">
              <Button
                size="sm"
                disabled={
                  !status.data ||
                  !!status.error ||
                  !dirty ||
                  configErrors.length > 0
                }
                onClick={() => save.mutate(config)}
              >
                保存策略配置
              </Button>
            </div>
          </fieldset>
          {configErrors.length > 0 && (
            <p role="alert" className="text-nc-bad">
              {configErrors.join(" ")}
            </p>
          )}
          <details className="rounded border p-3">
            <summary className="cursor-pointer">
              配置模拟账户凭证（Windows DPAPI 加密）
            </summary>
            <form
              className="mt-3 grid gap-3 sm:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                credential.mutate({
                  id,
                  apiKey,
                  apiSecret,
                  ...(venue === "okx" ? { passphrase } : {}),
                });
              }}
            >
              <label className="flex flex-col gap-1">
                API Key
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                API Secret
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={apiSecret}
                  onChange={(event) => setApiSecret(event.target.value)}
                />
              </label>
              {venue === "okx" && (
                <label className="flex flex-col gap-1">
                  Passphrase
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </label>
              )}
              <div className="sm:col-span-3">
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    !bot ||
                    bot.initialUsdt !== null ||
                    running ||
                    pending ||
                    !apiKey ||
                    !apiSecret ||
                    (venue === "okx" && !passphrase)
                  }
                >
                  保存模拟凭证
                </Button>
              </div>
            </form>
            <p className="mt-2 text-nc-text-4">
              先保存策略配置，再保存该平台对应模拟环境的凭证。为避免把另一账户混入现有账本，首次启动后不支持更换凭证；本版尚不支持密钥轮换。
            </p>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending || dirty || !status.data?.credentialConfigured}
              onClick={() => diagnose.mutate(id)}
            >
              检查模拟账户连接
            </Button>
            <Button
              size="sm"
              disabled={
                pending ||
                running ||
                dirty ||
                !status.data?.credentialConfigured ||
                !!status.error ||
                !diagnostic
              }
              onClick={() => control.mutate({ id, action: "start" })}
            >
              按下方摘要启动模拟自动交易
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !running}
              onClick={() => control.mutate({ id, action: "pause" })}
            >
              暂停
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !bot || bot.status === "stopped"}
              onClick={() => control.mutate({ id, action: "stop" })}
            >
              停止
            </Button>
          </div>
          <p className="rounded border p-3 leading-6">
            启动摘要：{accounts.find((account) => account[0] === id)?.[1]} ·
            BTCUSDT / ETHUSDT · {config.minutes}分钟 SMA{config.fast}/
            {config.slow} · 每币最多使用启动资金的 {config.allocation * 100}% ·
            金叉买入，死叉卖出策略持仓。
            <br />
            {bot?.initialUsdt
              ? `已冻结资金基线：${bot.initialUsdt} USDT。`
              : `首次启动以服务器当时可用 USDT 冻结资金基线${usdt ? `；最近诊断可用 ${usdt} USDT` : ""}。`}
            首次启动只建立行情基线。暂停、停止均不自动清仓；应用退出或电脑休眠时不执行，恢复后不补发历史信号。
          </p>
          {notice && <p role="status">{notice}</p>}
          {errors.map(
            (error, index) =>
              error && (
                <p key={index} role="alert" className="nc-text-bad">
                  {error.message}
                </p>
              ),
          )}
          {bot?.error && (
            <p role="alert" className="nc-text-bad">
              策略状态：{bot.error}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {(["BTCUSDT", "ETHUSDT"] as const).map((symbol) => (
              <div key={symbol} className="rounded border p-3">
                <strong>{symbol}</strong>
                <HoldingAlertEditor
                  market="crypto"
                  symbol={symbol}
                  account={id}
                />
                <p className="mt-2">
                  策略数量：{bot?.positions[symbol] ?? "—"}
                </p>
                <p className="mt-1">
                  资金上限：
                  {bot?.initialUsdt
                    ? `${new Big(bot.initialUsdt).times(config.allocation).toFixed(2)} USDT（启动资金基线 × ${config.allocation * 100}%）`
                    : "首次启动后冻结"}
                </p>
                <p className="mt-1">
                  最近处理K线：
                  {bot?.lastCandles[symbol]
                    ? timestamp(bot.lastCandles[symbol])
                    : "尚无"}
                </p>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap text-[13px]">
                  {JSON.stringify(
                    bot?.indicators[symbol] ?? "尚无均线与信号",
                    null,
                    2,
                  )}
                </pre>
              </div>
            ))}
          </div>
          {diagnostic && (
            <details className="rounded border p-3">
              <summary className="cursor-pointer">
                最近账户诊断快照：余额与挂单（非实时权益）
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(diagnostic, null, 2)}
              </pre>
            </details>
          )}
          <div>
            <h3 className="font-medium">策略订单与成交</h3>
            {!status.data?.orders.length && (
              <p className="mt-2 text-nc-text-4">
                暂无策略订单。受理不代表成交，持仓仅按确认的成交更新。
              </p>
            )}
            <div className="mt-2 max-h-96 space-y-2 overflow-auto">
              {status.data?.orders.map((order) => (
                <details key={order.clientId} className="rounded border p-3">
                  <summary className="cursor-pointer leading-6">
                    {order.symbol} · {order.side === "BUY" ? "买入" : "卖出"}{" "}
                    {order.side === "BUY" && order.quoteBudget
                      ? `预算 ${order.quoteBudget} USDT（估算数量 ${order.quantity}）`
                      : order.quantity}{" "}
                    · {order.state} · {timestamp(order.createdAt)}
                  </summary>
                  <p className="mt-2 break-all">
                    客户端编号：{order.clientId} · 平台编号：
                    {order.exchangeId ?? "待确认"}
                  </p>
                  {order.error && <p className="nc-text-bad">{order.error}</p>}
                  {order.decision && (
                    <details className="mt-2">
                      <summary className="cursor-pointer">
                        下单时策略与信号快照
                      </summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap">
                        {JSON.stringify(order.decision, null, 2)}
                      </pre>
                    </details>
                  )}
                  <p className="mt-2">成交 {order.fills.length} 笔</p>
                  {order.fills.map((fill) => (
                    <p key={fill.id} className="mt-1 break-all">
                      {fill.id}：{fill.quantity} × {fill.price} USDT · 手续费{" "}
                      {fill.fee} {fill.feeAsset}
                    </p>
                  ))}
                  {!finished.has(order.state) && (
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        cancel.mutate({ id, clientId: order.clientId })
                      }
                    >
                      请求撤单并对账
                    </Button>
                  )}
                </details>
              ))}
            </div>
          </div>
          <p className="text-nc-text-4">
            本页为模拟执行记录，费用缺失或结果待确认会保留原因，不构成可信历史策略业绩。
          </p>
        </div>
      </PanelVisibility>
    </div>
  );
}
