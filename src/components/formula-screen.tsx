"use client";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import { useState } from "react";
import { api } from "~/trpc/react";
import { validateScreenFormula } from "~/lib/formula-screen";
import { arities, futureFunctions } from "~/lib/tdx-formula-check";
export function FormulaScreen({
  onStarted,
}: {
  onStarted: (id: string) => void;
}) {
  const [id, setId] = useState<string | undefined>();
  const [name, setName] = useState("均线金叉");
  const [source, setSource] = useState("选股:CROSS(MA(C,N1),MA(C,N2));");
  const [params, setParams] = useState('{"N1":5,"N2":20}');
  const [checked, setChecked] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const key = JSON.stringify([name, source, params]);
  const utils = api.useUtils();
  const formulas = api.formulas.useQuery();
  const save = api.saveFormula.useMutation();
  const run = api.formulaScreen.useMutation();
  const busy = save.isPending || run.isPending;
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
    <section className="panel" aria-label="通达信公式选股">
      <h3>通达信公式选股</h3>
      <p>
        本地全 A 股 · 已完成日线 · 不复权。参数使用
        N1/N2…；恰有一个输出，中间变量用 :=。
      </p>
      <div className="inline-form">
        <label>
          已保存公式
          <Select
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
          <button onClick={() => void formulas.refetch()}>重试读取</button>
        </p>
      )}
      <label>
        公式源码
        <Textarea
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
          value={params}
          onChange={(e) => setParams(e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <div className="inline-form">
        <button
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
        </button>
        <button
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
        </button>
        <button
          disabled={busy || checked !== key}
          onClick={async () => {
            try {
              const job = await run.mutateAsync(input());
              onStarted(job.id);
              setMessage("全市场任务已启动；进度、取消与结果见下方候选表。");
            } catch (e) {
              error(e);
            }
          }}
        >
          全市场执行公式
        </button>
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
