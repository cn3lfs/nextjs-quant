"use client";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import { useState, useSyncExternalStore } from "react";
import { api } from "~/trpc/react";
import { validateScreenFormula } from "trading-strategies/formula/formula-screen";
import {
  arities,
  futureFunctions,
} from "trading-strategies/formula/tdx-formula-check";
import { usePanelVisible } from "~/components/workbench/keep-alive";
import { MethodologyPopover } from "~/components/panels";
const subscribeToReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const thsdkSymbolExample = "sh600519, sz000001, sz300033";
const thsdkSymbolPattern = /^(sh|sz|bj)\d{6}$/;
const thsdkSymbolLimit = 200;
function parseThsdkSymbols(text: string) {
  return [
    ...new Set(
      text
        .split(/[\s,，;；]+/)
        .map((symbol) => symbol.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
/** Normalize and bound the explicit THS pool; nothing is truncated or filled in. */
function validateThsdkSymbols(
  text: string,
): { symbols: string[] } | { error: string } {
  const symbols = parseThsdkSymbols(text);
  if (symbols.length === 0)
    return {
      error: `请填写同花顺证券代码（1–${thsdkSymbolLimit} 只），例如 ${thsdkSymbolExample}。`,
    };
  const invalid = symbols.filter((symbol) => !thsdkSymbolPattern.test(symbol));
  if (invalid.length > 0)
    return {
      error: `同花顺证券代码格式无效：${invalid.join("、")}；应为 sh/sz/bj 前缀加 6 位数字。`,
    };
  if (symbols.length > thsdkSymbolLimit)
    return {
      error: `同花顺证券代码最多 ${thsdkSymbolLimit} 只，当前 ${symbols.length} 只，请精简后再执行。`,
    };
  return { symbols };
}
export function FormulaScreen({
  onStarted,
}: {
  onStarted: (id: string) => void;
}) {
  const visible = usePanelVisible();
  // Static HTML must not accept edits before React owns the controlled values.
  const ready = useSyncExternalStore(
    subscribeToReady,
    clientReady,
    serverReady,
  );
  const [id, setId] = useState<string | undefined>();
  const [name, setName] = useState("均线金叉");
  const [source, setSource] = useState("选股:CROSS(MA(C,N1),MA(C,N2));");
  const [params, setParams] = useState('{"N1":5,"N2":20}');
  const [checked, setChecked] = useState<string | null>(null);
  const [marketSource, setMarketSource] = useState<"local" | "thsdk">("local");
  const [thsdkSymbolsText, setThsdkSymbolsText] = useState("");
  const [message, setMessage] = useState("");
  const key = JSON.stringify([name, source, params]);
  const utils = api.useUtils();
  const formulas = api.formulas.useQuery(undefined, { enabled: visible });
  const save = api.saveFormula.useMutation();
  const run = api.formulaScreen.useMutation();
  const draft = api.formulaFromText.useMutation();
  const [request, setRequest] = useState("");
  const [explained, setExplained] = useState<{
    lines: { line: string; meaning: string }[];
    unsupported: string[];
  } | null>(null);
  const busy = !ready || save.isPending || run.isPending || draft.isPending;
  async function generate() {
    setChecked(null);
    setExplained(null);
    setMessage("");
    try {
      const result = await draft.mutateAsync(request);
      // The draft replaces the editor but is never launched from here: the
      // user still runs the gate and confirms.
      setId(undefined);
      setName(request.slice(0, 40));
      setSource(result.source);
      setParams("{}");
      if (result.ok) {
        setExplained({
          lines: result.explanation,
          unsupported: result.unsupported,
        });
        setMessage("已生成公式，请核对含义后点击“语法检查与未来函数门禁”。");
      } else {
        setExplained({ lines: [], unsupported: result.unsupported });
        setMessage(
          "模型两次生成的公式均未通过校验，已放入编辑框供手工修改：\n" +
            result.issues
              .map(
                (i) =>
                  `第${i.line}行${i.name ? ` ${i.name}` : ""}：${i.reason}`,
              )
              .join("\n"),
        );
      }
    } catch (e) {
      error(e);
    }
  }
  function input() {
    return validateScreenFormula({
      id,
      name,
      source,
      parameters: JSON.parse(params) as unknown,
    });
  }
  function error(e: unknown) {
    setMessage(e instanceof Error ? e.message : "操作失败");
  }
  return (
    <section className="panel" aria-label="通达信公式选股" aria-busy={!ready}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="m-0">通达信公式选股</h3>
        <MethodologyPopover
          title="公式选股口径"
          buttonLabel="口径说明"
          items={[
            {
              label: "数据范围与价格",
              detail:
                "本地全 A 股 · 已完成日线 · 前复权信号价；成交与账户保留原价。",
            },
            {
              label: "同花顺数据源（可选）",
              detail:
                "信号价使用同花顺原生前复权，不叠加本地 GBBQ 复权；证券池严格按指定的 1–200 只代码执行，不读取本地目录、不静默截断。同花顺行情可能延迟，盘中未完成的日线不参与计算。",
            },
            {
              label: "参数与语法",
              detail:
                "参数使用 N1/N2…；恰有一个输出，中间变量用 :=。语法检查与未来函数门禁通过后才能保存或执行。",
            },
            {
              label: "执行边界",
              detail:
                "未来函数命中即拒绝执行；REF 负偏移或无法证明非负整数时拒绝。窗口不足、除零和无效定义域返回空值。暂不支持财务、即时行情、绘图或随机函数。",
            },
          ]}
        />
      </div>
      <div className="inline-form">
        <label>
          已保存公式
          <Select
            disabled={!ready}
            value={id ?? ""}
            onValueChange={(selected) => {
              const f = formulas.data?.find((f) => f.id === selected);
              setChecked(null);
              setMessage("");
              if (f) {
                setId(f.id);
                setName(f.name);
                setSource(f.source);
                setParams(JSON.stringify(f.parameters));
              } else setId(undefined);
            }}
          >
            <SelectTrigger aria-label="已保存公式" className="w-full">
              <SelectValue placeholder="新公式" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">新公式</SelectItem>
              {formulas.data?.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label>
          公式名称
          <Input
            aria-label="公式名称"
            disabled={!ready}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>
      {formulas.isLoading && <p>正在读取公式…</p>}
      {formulas.error && (
        <p role="alert">
          {formulas.error.message}{" "}
          <Button variant="plain" onClick={() => void formulas.refetch()}>
            重试读取
          </Button>
        </p>
      )}
      <div className="inline-form">
        <label className="grow">
          一句话选股
          <Input
            aria-label="一句话选股"
            disabled={!ready}
            value={request}
            maxLength={500}
            placeholder="例如：MACD 金叉、RPS120 大于 90、近 5 日放量"
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && request.trim().length >= 2 && !busy)
                void generate();
            }}
          />
        </label>
        <Button
          variant="outline"
          disabled={busy || request.trim().length < 2}
          onClick={() => void generate()}
        >
          {draft.isPending ? "正在生成…" : "生成公式"}
        </Button>
      </div>
      {explained && (
        <div aria-label="公式解释">
          {explained.lines.length > 0 && (
            <ul>
              {explained.lines.map((l, i) => (
                <li key={i}>
                  <code>{l.line}</code> — {l.meaning}
                </li>
              ))}
            </ul>
          )}
          {explained.unsupported.length > 0 && (
            <p role="alert">
              以下条件无法用本地公式表达，未包含在公式中：
              {explained.unsupported.join("；")}
            </p>
          )}
        </div>
      )}
      <label>
        公式源码
        <Textarea
          disabled={!ready}
          className="field-sizing-fixed"
          aria-label="公式源码"
          rows={10}
          style={{ width: "100%", fontFamily: "monospace" }}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label>
        参数 JSON
        <Input
          aria-label="公式参数 JSON"
          disabled={!ready}
          value={params}
          onChange={(e) => setParams(e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <div className="inline-form">
        <label>
          数据源
          <Select
            disabled={!ready}
            value={marketSource}
            onValueChange={(value) => {
              if (value === "local" || value === "thsdk")
                setMarketSource(value);
            }}
          >
            <SelectTrigger aria-label="数据源" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">本地通达信（默认）</SelectItem>
              <SelectItem value="thsdk">同花顺 (THSDK)</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      {marketSource === "thsdk" && (
        <div className="inline-form">
          <label className="grow">
            同花顺证券代码（1–200 只，逗号/空格分隔）
            <Input
              aria-label="同花顺证券代码"
              disabled={!ready}
              value={thsdkSymbolsText}
              placeholder={thsdkSymbolExample}
              maxLength={4000}
              onChange={(e) => setThsdkSymbolsText(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={!ready}
            onClick={() => setThsdkSymbolsText(thsdkSymbolExample)}
          >
            填入示例标的
          </Button>
        </div>
      )}
      <div className="inline-form">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setChecked(null);
            try {
              input();
              setChecked(key);
              setMessage("语法检查通过；未来函数门禁通过。可保存或执行。");
            } catch (e) {
              error(e);
            }
          }}
        >
          语法检查与未来函数门禁
        </Button>
        <Button
          variant="outline"
          disabled={busy || checked !== key}
          onClick={async () => {
            try {
              const f = await save.mutateAsync(input());
              setId(f.id);
              await utils.formulas.invalidate();
              setMessage("公式已保存");
            } catch (e) {
              error(e);
            }
          }}
        >
          保存公式
        </Button>
        <Button
          disabled={busy || checked !== key}
          onClick={async () => {
            try {
              if (marketSource === "thsdk") {
                const pool = validateThsdkSymbols(thsdkSymbolsText);
                if ("error" in pool) {
                  setMessage(pool.error);
                  return;
                }
                const job = await run.mutateAsync({
                  ...input(),
                  marketSource: "thsdk",
                  symbols: pool.symbols,
                });
                onStarted(job.id);
                setMessage(
                  `同花顺公式选股任务已启动（${pool.symbols.length} 只指定标的）；进度、取消与结果见下方候选表。`,
                );
                return;
              }
              const job = await run.mutateAsync(input());
              onStarted(job.id);
              setMessage("全市场任务已启动；进度、取消与结果见下方候选表。");
            } catch (e) {
              error(e);
            }
          }}
        >
          {marketSource === "thsdk" ? "同花顺执行公式" : "全市场执行公式"}
        </Button>
      </div>
      <p role="status" style={{ whiteSpace: "pre-wrap" }}>
        {checked !== null && checked !== key
          ? "公式已修改，请重新检查。"
          : message}
      </p>
      <details>
        <summary>支持函数（{Object.keys(arities).length}）与执行边界</summary>
        <p>{Object.keys(arities).join(" · ")}</p>
        <p>
          未来函数命中即拒绝执行：{futureFunctions.join(" · ")}。REF
          负偏移或无法证明非负整数时也拒绝。所有分支均检查，不允许警告后继续。
        </p>
        <p>
          窗口不足、除零和无效定义域返回空值。窗口周期使用静态整数；DMA
          权重支持序列且须在 0 与 1 之间；TMA 两个系数使用小于 1
          的静态数值。暂不支持财务、即时行情、绘图或随机函数。
        </p>
      </details>
    </section>
  );
}
