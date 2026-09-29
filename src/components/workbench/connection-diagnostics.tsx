import { useState } from "react";
import { Database } from "@phosphor-icons/react/ssr";
import type { Settings } from "~/lib/domain";
import {
  connectionConfiguration,
  type ConnectionCheckInput,
  type ConnectionCheckResult,
} from "~/lib/settings/connection-check";
import { sameSetting } from "~/lib/settings/settings-draft";
import { marketSourceLabels } from "~/lib/market/market-source";
import { api } from "~/trpc/react";
import { Panel, Pill } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { Field, stamp } from "./shared";

export function ConnectionDiagnostics({
  value,
  dirty,
}: {
  value: Settings;
  dirty: boolean;
}) {
  const [source, setSource] = useState<ConnectionCheckInput["source"]>(
    value.marketDataSource === "auto" ? "local" : value.marketDataSource,
  );
  const [symbol, setSymbol] = useState("sh600000");
  const [period, setPeriod] = useState<ConnectionCheckInput["period"]>("day");
  const [result, setResult] = useState<ConnectionCheckResult | null>(null);
  const [lastSuccess, setLastSuccess] = useState<ConnectionCheckResult | null>(
    null,
  );
  const check = api.checkConnection.useMutation({
    onMutate: () => {
      setResult(null);
    },
    onSuccess: (response) => {
      setResult(response);
      if (response.data === "ok") setLastSuccess(response);
    },
  });
  const configuration = connectionConfiguration(value);
  const matches = (response: ConnectionCheckResult) =>
    response.source === source &&
    response.symbol === symbol &&
    response.period === period &&
    sameSetting(response.configuration, configuration);
  const stale = result !== null && !matches(result);
  const valid = /^(sh|sz|bj)\d{6}$/.test(symbol);
  return (
    <Panel
      icon={Database}
      title="连接与数据检查"
      span={6}
      note="只检查所选源、证券和周期，最多核验 64 根返回样本；不会扫描全市场、切换来源或调用模型。"
    >
      <p className="mb-3 text-nc-text-3">
        当前默认：{marketSourceLabels[value.marketDataSource]}
        。检查使用已保存配置。
      </p>
      {source === "tencent" && (
        <p className="mb-3 text-nc-warn">
          腾讯源为延迟行情；检查通过也不代表实时行情。
        </p>
      )}
      <div className="form-grid">
        <Field label="检查来源">
          <Select
            value={source}
            onValueChange={(v) =>
              setSource(v as ConnectionCheckInput["source"])
            }
          >
            <SelectTrigger aria-label="检查来源">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["local", "pytdx", "eastmoney", "tencent"] as const).map(
                (key) => (
                  <SelectItem value={key} key={key}>
                    {marketSourceLabels[key]}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </Field>
        <Field label="样本证券">
          <Input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.trim().toLowerCase())}
            aria-invalid={!valid}
            aria-describedby={!valid ? "connection-symbol-error" : undefined}
          />
        </Field>
        <Field label="检查周期">
          <Select
            value={period}
            onValueChange={(v) =>
              setPeriod(v as ConnectionCheckInput["period"])
            }
          >
            <SelectTrigger aria-label="检查周期">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">日线</SelectItem>
              <SelectItem value="5m">五分钟</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {!valid && (
        <p id="connection-symbol-error" className="text-nc-bad">
          请输入带市场前缀的六位证券代码，例如 sh600000。
        </p>
      )}
      {dirty && (
        <p className="my-2 text-nc-warn">
          有未保存修改；此次检查仍使用已保存配置。
        </p>
      )}
      <Button
        disabled={!valid || check.isPending}
        onClick={() => check.mutate({ source, symbol, period, configuration })}
      >
        {check.isPending ? "检查中（最多 10 秒）" : "检查已保存配置"}
      </Button>
      {check.error && (
        <p role="alert" className="mt-2 text-nc-bad">
          {check.error.message}
        </p>
      )}
      {result ? (
        <div className="mt-3 space-y-2" aria-live="polite">
          {stale && (
            <p className="text-nc-warn">
              以下为旧配置或旧选择的检查结果，请重新检查。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Pill
              tone={stale ? "idle" : result.connection === "ok" ? "ok" : "warn"}
            >
              连接：
              {
                { ok: "可访问", error: "失败", unknown: "未确认" }[
                  result.connection
                ]
              }
            </Pill>
            <Pill tone={stale ? "idle" : result.data === "ok" ? "ok" : "warn"}>
              数据：
              {
                {
                  ok: "样本可用",
                  empty: "样本为空",
                  invalid: "样本无效",
                  unavailable: "不可用",
                }[result.data]
              }
            </Pill>
            <Pill
              tone={!stale && result.freshness === "aligned" ? "ok" : "warn"}
            >
              时点：
              {
                { aligned: "与参考一致", lagging: "落后", unknown: "无法确认" }[
                  result.freshness
                ]
              }
            </Pill>
          </div>
          <p>{result.message}</p>
          <p className="text-nc-text-3">下一步：{result.nextAction}</p>
          <details>
            <summary>检查范围与时间</summary>
            <div className="mt-2 text-nc-text-3">
              <div>
                来源：{marketSourceLabels[result.source]} · {result.symbol} ·{" "}
                {result.period} · {result.sampleCount} 根
              </div>
              <div>
                检查时间：{stamp(result.checkedAt)} · 用时 {result.elapsedMs} ms
              </div>
              <div>行情最后时点：{result.dataAsOf ?? "未知"}</div>
              <div>
                参考时点：{result.referenceAsOf ?? "未知"} ·{" "}
                {result.referenceSource}
              </div>
            </div>
          </details>
        </div>
      ) : (
        <p className="mt-3 text-nc-text-3">
          {check.isPending
            ? "正在检查；此前结果不代表本次状态。"
            : check.error
              ? "此次检查未完成，先前成功记录不代表当前状态。"
              : "尚未检查。目录已配置或已有扫描记录，不代表连接和行情当前可用。"}
        </p>
      )}
      {lastSuccess && matches(lastSuccess) && result?.data !== "ok" && (
        <p className="mt-2 text-nc-text-3">
          此范围上次样本读取成功：{stamp(lastSuccess.checkedAt)}（本次会话）
        </p>
      )}
    </Panel>
  );
}
