"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { RouterOutputs } from "~/trpc/react";

export function PaperSettingsPanel() {
  const query = api.paperSettings.useQuery();
  const accounts = api.paperAccounts.useQuery();
  const utils = api.useUtils();
  const [message, setMessage] = useState("");
  const register = api.registerPaperCandidates.useMutation({
    onSuccess: (r) => {
      setMessage(`已登记 ${r.created} 个新模拟账户，共 ${r.total} 个。`);
      void utils.paperAccounts.invalidate();
    },
  });
  const advance = api.advancePaperAccounts.useMutation({
    onSuccess: () => {
      setMessage("已检查完成行情与回执；未就绪账户保留原事实。");
      void utils.paperAccounts.invalidate();
    },
  });
  return (
    <section
      aria-label="纸面账户设置"
      className="space-y-4 rounded-lg border bg-nc-card p-4"
    >
      <h2 className="text-lg font-semibold">纸面账户设置</h2>
      <p>
        默认候选分别记账；仅真实完成bar按回测同源规则模拟成交。应用关闭后补齐记账，不补发提醒。
      </p>
      <p className="text-sm text-nc-text-3">
        具有冻结本金的研究候选沿用该本金并独立记账；其余候选使用下方默认设置。
      </p>
      {query.data && (
        <PaperDefaults
          key={JSON.stringify(query.data)}
          value={query.data}
          onSaved={() => void utils.paperSettings.invalidate()}
        />
      )}
      {query.error && <p role="alert">{query.error.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={register.isPending} onClick={() => register.mutate()}>
          按冻结规则登记候选
        </Button>
        <Button
          variant="outline"
          disabled={advance.isPending}
          onClick={() => advance.mutate()}
        >
          检查并推进纸面账户
        </Button>
      </div>
      {(register.error || advance.error) && (
        <p role="alert">{register.error?.message ?? advance.error?.message}</p>
      )}
      {message && <p role="status">{message}</p>}
      <p className="text-sm text-nc-text-3">
        模拟场所镜像默认关闭；币安凭证在既有模拟账户页面配置，同花顺须先配置并启用模拟盘。每个模拟场所仅一个纸面账户独占；差异与未知结果在账户明细中显示。镜像按当前场所成交，价格可能与本地历史bar不同。
      </p>
      {accounts.data?.map((a) => (
        <MirrorSetting
          key={`${a.id}:${a.mirrorRevision}`}
          account={a}
          onSaved={() => void utils.paperAccounts.invalidate()}
        />
      ))}
    </section>
  );
}
function PaperDefaults({
  value,
  onSaved,
}: {
  value: RouterOutputs["paperSettings"];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const save = api.savePaperSettings.useMutation({ onSuccess: onSaved });
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <label>
        A股默认本金（CNY）
        <Input
          aria-label="纸面A股默认本金"
          type="number"
          value={draft.equityInitial}
          onChange={(e) =>
            setDraft({ ...draft, equityInitial: Number(e.target.value) })
          }
        />
      </label>
      <label>
        币种默认本金（USDT）
        <Input
          aria-label="纸面币种默认本金"
          type="number"
          value={draft.cryptoInitial}
          onChange={(e) =>
            setDraft({ ...draft, cryptoInitial: Number(e.target.value) })
          }
        />
      </label>
      <label>
        合账方式
        <Select
          value={draft.grouping}
          onValueChange={(v) =>
            setDraft({ ...draft, grouping: v as "candidate" | "sleeve" })
          }
        >
          <SelectTrigger aria-label="纸面合账方式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="candidate">每候选独立</SelectItem>
            <SelectItem value="sleeve">每市场分仓合账</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <Button disabled={save.isPending} onClick={() => save.mutate(draft)}>
        保存纸面默认设置
      </Button>
      {save.error && <p role="alert">{save.error.message}</p>}
      {save.isSuccess && <p role="status">纸面默认设置已保存。</p>}
    </div>
  );
}
function MirrorSetting({
  account: a,
  onSaved,
}: {
  account: RouterOutputs["paperAccounts"][number];
  onSaved: () => void;
}) {
  const [value, setValue] = useState(
    a.mirror.venue === "off"
      ? "off"
      : a.mirror.venue === "ths"
        ? "ths"
        : a.mirror.network,
  );
  const [initial, setInitial] = useState(a.initial);
  const mirror = api.configurePaperMirror.useMutation({ onSuccess: onSaved });
  const capital = api.configurePaperInitial.useMutation({ onSuccess: onSaved });
  return (
    <div className="space-y-2 rounded border p-3">
      <strong className="break-all">模拟 · {a.id}</strong>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={`${a.id}初始本金`}
          type="number"
          disabled={!!a.lastBar}
          value={initial}
          onChange={(e) => setInitial(Number(e.target.value))}
        />
        <Button
          variant="outline"
          disabled={!!a.lastBar || capital.isPending}
          onClick={() => capital.mutate({ id: a.id, initial })}
        >
          保存初始本金
        </Button>
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger aria-label={`${a.id}模拟镜像`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">镜像关闭</SelectItem>
            {a.market === "crypto" ? (
              <>
                <SelectItem value="demo">币安 Demo</SelectItem>
                <SelectItem value="testnet">币安 Spot Testnet</SelectItem>
              </>
            ) : (
              <SelectItem value="ths">同花顺模拟盘</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Button
          disabled={mirror.isPending}
          onClick={() =>
            mirror.mutate({
              id: a.id,
              mirror:
                value === "off"
                  ? { venue: "off" }
                  : value === "ths"
                    ? { venue: "ths", network: "simulation" }
                    : {
                        venue: "binance",
                        network: value as "demo" | "testnet",
                      },
            })
          }
        >
          保存模拟镜像
        </Button>
      </div>
      {(mirror.error || capital.error) && (
        <p role="alert">{mirror.error?.message ?? capital.error?.message}</p>
      )}
      {mirror.isSuccess && <p role="status">模拟镜像设置已保存。</p>}
    </div>
  );
}
