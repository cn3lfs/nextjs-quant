import { useState } from "react";
import { Database } from "@phosphor-icons/react/ssr";
import type { Settings } from "~/lib/domain";
import {
  connectionConfiguration,
  type ConnectionCheckInput,
  type ConnectionCheckResult,
} from "~/lib/settings/connection-check";
import { sameSetting } from "~/lib/settings/settings-draft";
import {
  concreteMarketSources,
  marketSourceLabels,
} from "~/lib/market/market-source";
import { api } from "~/trpc/react";
import { Panel, Pill } from "../panels";
import { usePanelVisible } from "./keep-alive";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Field, stamp } from "./shared";

const connectionLabels = {
  ok: "可访问",
  error: "失败",
  unknown: "未确认",
} as const;
const dataLabels = {
  ok: "样本可用",
  empty: "样本为空",
  invalid: "样本无效",
  unavailable: "不可用",
} as const;
const periodLabels = {
  day: "日线",
  "5m": "五分钟",
} as const;

type CheckSource = ConnectionCheckInput["source"];
type CheckPeriod = keyof typeof periodLabels;

/** THS 回执只在同一配置修订、同一认证世代内有效。 */
function sameThsdkState(
  a: ConnectionCheckInput["thsdkState"],
  b: ConnectionCheckInput["thsdkState"],
) {
  return (
    a?.configRevision === b?.configRevision &&
    a?.authGeneration === b?.authGeneration
  );
}

/** A receipt is only trustworthy when the response echoes the request. */
function sameCheckIdentity(
  response: ConnectionCheckResult,
  input: ConnectionCheckInput,
) {
  return (
    response.source === input.source &&
    response.symbol === input.symbol &&
    response.period === input.period &&
    sameSetting(response.configuration, input.configuration) &&
    sameThsdkState(response.thsdkState, input.thsdkState)
  );
}

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
  const [period, setPeriod] = useState<CheckPeriod>("day");
  const [result, setResult] = useState<ConnectionCheckResult | null>(null);
  const [lastSuccess, setLastSuccess] = useState<ConnectionCheckResult | null>(
    null,
  );
  // One completed receipt per source for this mount; rechecks replace in place.
  const [receipts, setReceipts] = useState<
    Partial<Record<CheckSource, ConnectionCheckResult>>
  >({});
  const [identityError, setIdentityError] = useState<string | null>(null);
  const visible = usePanelVisible();
  // THS 回执绑定配置修订与认证世代；状态读取本身不发外部行情请求。
  const thsdkStatus = api.thsdkStatus.useQuery(undefined, {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const check = api.checkConnection.useMutation({
    onMutate: () => {
      setResult(null);
      setIdentityError(null);
    },
    onSuccess: (response, input) => {
      if (!sameCheckIdentity(response, input)) {
        setResult(null);
        setIdentityError(
          "检查结果与发起请求的来源、证券、周期或已保存配置不一致，已忽略本次结果。",
        );
        return;
      }
      setResult(response);
      setReceipts((current) => ({ ...current, [input.source]: response }));
      if (response.data === "ok") setLastSuccess(response);
    },
  });
  const configuration = connectionConfiguration(value);
  // 当前 THS 身份始终随状态更新：登出或改配置后，旧回执在对照表中自然消失。
  const thsdkState = thsdkStatus.data
    ? {
        configRevision: thsdkStatus.data.configRevision,
        authGeneration: thsdkStatus.data.authGeneration,
      }
    : undefined;
  const matches = (response: ConnectionCheckResult) =>
    response.source === source &&
    response.symbol === symbol &&
    response.period === period &&
    sameSetting(response.configuration, configuration) &&
    (source !== "thsdk" || sameThsdkState(response.thsdkState, thsdkState));
  const stale = result !== null && !matches(result);
  // Visibility follows the current form scope and saved configuration; the
  // stored receipt keeps the scope it was actually confirmed under. THS 回执
  // 额外要求同一配置修订与认证世代，其他来源不受影响。
  const comparisonRows = concreteMarketSources
    .map((key) => receipts[key])
    .filter(
      (receipt): receipt is ConnectionCheckResult =>
        receipt !== undefined &&
        receipt.symbol === symbol &&
        receipt.period === period &&
        sameSetting(receipt.configuration, configuration) &&
        (receipt.source !== "thsdk" ||
          sameThsdkState(receipt.thsdkState, thsdkState)),
    );
  const valid = /^(sh|sz|bj)\d{6}$/.test(symbol);
  const thsdkBlocked = source === "thsdk" && !thsdkState;
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
      {source === "thsdk" && (
        <div className="mb-3 space-y-1 text-[12px]">
          {thsdkStatus.error ? (
            <p className="text-nc-warn">
              无法读取同花顺状态，暂时不能发起 THS 检查。
            </p>
          ) : !thsdkStatus.data ? (
            <p className="text-nc-text-3">正在读取同花顺认证状态…</p>
          ) : !thsdkStatus.data.enabled ? (
            <p className="text-nc-warn">
              同花顺行情已停用，检查会直接返回限制原因。
            </p>
          ) : thsdkStatus.data.state !== "authenticated" ? (
            <p className="text-nc-warn">
              同花顺尚未认证（{thsdkStatus.data.state}
              ），请先在「同花顺行情」中登录。
            </p>
          ) : (
            <p className="text-nc-text-3">
              检查绑定配置修订 {thsdkStatus.data.configRevision} · 认证世代{" "}
              {thsdkStatus.data.authGeneration}；改配置或登出后旧回执自动失效。
            </p>
          )}
        </div>
      )}
      <div className="form-grid">
        <Field label="检查来源">
          <Select
            value={source}
            onValueChange={(v) => {
              setIdentityError(null);
              setSource(v as ConnectionCheckInput["source"]);
            }}
          >
            <SelectTrigger aria-label="检查来源">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {concreteMarketSources.map((key) => (
                <SelectItem value={key} key={key}>
                  {marketSourceLabels[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="样本证券">
          <Input
            value={symbol}
            onChange={(e) => {
              setIdentityError(null);
              setSymbol(e.target.value.trim().toLowerCase());
            }}
            aria-invalid={!valid}
            aria-describedby={!valid ? "connection-symbol-error" : undefined}
          />
        </Field>
        <Field label="检查周期">
          <Select
            value={period}
            onValueChange={(v) => {
              setIdentityError(null);
              if (v === "day" || v === "5m") setPeriod(v);
            }}
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
        disabled={!valid || check.isPending || thsdkBlocked}
        onClick={() =>
          check.mutate({
            source,
            symbol,
            period,
            configuration,
            ...(source === "thsdk" && thsdkState ? { thsdkState } : {}),
          })
        }
      >
        {check.isPending ? "检查中（最多 10 秒）" : "检查已保存配置"}
      </Button>
      {check.error && (
        <p role="alert" className="mt-2 text-nc-bad">
          {check.error.message}
        </p>
      )}
      {identityError && (
        <p role="alert" className="mt-2 text-nc-bad">
          {identityError}
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
              {connectionLabels[result.connection]}
            </Pill>
            <Pill tone={stale ? "idle" : result.data === "ok" ? "ok" : "warn"}>
              数据：
              {dataLabels[result.data]}
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
      ) : identityError ? null : (
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
      {comparisonRows.length >= 2 && (
        <section className="mt-4" aria-labelledby="connection-comparison-title">
          <h4 id="connection-comparison-title">同范围来源对照</h4>
          <p className="text-nc-text-3">
            已保存配置 · {symbol} · {periodLabels[period]}
          </p>
          <p className="text-nc-text-3">各来源显示本页最近一次已完成的检查。</p>
          {source !== "tencent" &&
            comparisonRows.some((receipt) => receipt.source === "tencent") && (
              <p className="text-nc-warn">
                腾讯源为延迟行情；检查通过也不代表实时行情。
              </p>
            )}
          <div className="mt-2">
            <Table data-sortable="false">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">来源</TableHead>
                  <TableHead scope="col">连接 / 样本</TableHead>
                  <TableHead scope="col">行情最后时点</TableHead>
                  <TableHead scope="col">检查时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparisonRows.map((receipt) => (
                  <TableRow key={receipt.source}>
                    <TableCell>{marketSourceLabels[receipt.source]}</TableCell>
                    <TableCell>
                      {connectionLabels[receipt.connection]} ·{" "}
                      {dataLabels[receipt.data]}
                    </TableCell>
                    <TableCell>{receipt.dataAsOf ?? "未知"}</TableCell>
                    <TableCell>{stamp(receipt.checkedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </Panel>
  );
}
