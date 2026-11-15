"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import {
  accountReviewSettingsSchema,
  type AccountReviewSettings,
} from "~/lib/portfolio/account-workspace";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Segmented } from "../panels";

export function AccountReviewSettingsPanel() {
  const query = api.accountReviewSettings.useQuery();
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return <p role="status">正在读取账户风控设置…</p>;
  return <SettingsEditor initial={query.data} />;
}
function SettingsEditor({ initial }: { initial: AccountReviewSettings }) {
  const [draft, setDraft] = useState(initial),
    [market, setMarket] = useState<"cn-equity" | "crypto">("cn-equity"),
    [dimension, setDimension] = useState<
      "market" | "sleeve" | "symbol" | "industry"
    >("market"),
    [error, setError] = useState("");
  const save = api.saveAccountReviewSettings.useMutation();
  return (
    <section className="space-y-4">
      <h2>账户敞口与复盘设置</h2>
      <p>
        上限按该市场设置资本计算；包含所有真实持仓及未完成计划预留，不含纸面/模拟。超限须查看明细后明确确认，计划保存检查时的配置和超限记录。
      </p>
      <div className="grid gap-3 lg:grid-cols-3">
        {[
          { key: "decayPercentile", label: "衰减分位（0至0.5）" },
          { key: "minimumSamples", label: "每侧最小样本" },
          { key: "chaseFraction", label: "追高偏离比例" },
        ].map((f) => (
          <label key={f.key}>
            {f.label}
            <Input
              type="number"
              step="any"
              value={draft[f.key as "minimumSamples"]}
              onChange={(e) =>
                setDraft({ ...draft, [f.key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <form
        className="space-y-3 rounded border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const candidate = {
            ...draft,
            caps: [
              ...draft.caps,
              {
                market,
                dimension,
                key: dimension === "market" ? market : String(f.get("key")),
                fraction: Number(f.get("fraction")),
              },
            ],
          };
          const parsed = accountReviewSettingsSchema.safeParse(candidate);
          if (!parsed.success) {
            setError(parsed.error.issues.map((i) => i.message).join("；"));
            return;
          }
          setDraft(parsed.data);
          setError("");
        }}
      >
        <Segmented
          label="上限市场"
          value={market}
          options={[
            { value: "cn-equity", label: "A股" },
            { value: "crypto", label: "数字货币" },
          ]}
          onChange={(v) => setMarket(v as typeof market)}
        />
        <Segmented
          label="上限维度"
          value={dimension}
          options={[
            { value: "market", label: "市场" },
            { value: "sleeve", label: "分仓" },
            { value: "symbol", label: "单票" },
            { value: "industry", label: "行业" },
          ]}
          onChange={(v) => setDimension(v as typeof dimension)}
        />
        <label>
          分组ID（市场可空；行业为当前成分名称）
          <Input name="key" required={dimension !== "market"} />
        </label>
        <label>
          资本比例上限（例如0.2）
          <Input
            name="fraction"
            type="number"
            step="any"
            min="0.001"
            max="1"
            required
          />
        </label>
        <Button>添加上限</Button>
      </form>
      {draft.caps.map((c, i) => (
        <p key={i}>
          {c.market} / {c.dimension} / {c.key} ≤ {c.fraction * 100}%{" "}
          <Button
            variant="outline"
            onClick={() =>
              setDraft({
                ...draft,
                caps: draft.caps.filter((_, index) => index !== i),
              })
            }
          >
            移除
          </Button>
        </p>
      ))}
      <Button
        disabled={save.isPending}
        onClick={() => {
          const parsed = accountReviewSettingsSchema.safeParse(draft);
          if (!parsed.success) {
            setError(parsed.error.issues.map((i) => i.message).join("；"));
            return;
          }
          setError("");
          save.mutate(parsed.data);
        }}
      >
        保存账户风控设置
      </Button>
      {(error || save.error) && (
        <p role="alert">{error || save.error?.message}</p>
      )}
      {save.isSuccess && <p role="status">已保存账户风控设置。</p>}
    </section>
  );
}
