"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { LedgerInput } from "../signals/ledger-fields";
import { useTaskVisible } from "../workbench/use-task-visible";
export function HoldingAlertEditor({
  market,
  symbol,
  account = "",
  initialStop,
}: {
  market: "cn-equity" | "crypto";
  symbol: string;
  account?: string;
  initialStop?: number | null;
}) {
  const visible = useTaskVisible();
  const utils = api.useUtils();
  const saved = api.holdingAlert.useQuery(
    { market, symbol, account },
    { enabled: visible },
  );
  const [stopDraft, setStop] = useState<string>();
  const [targetDraft, setTarget] = useState<string>();
  const [trailingDraft, setTrailing] = useState<string>();
  const [sleeveDraft, setSleeve] = useState<string>();
  const stop =
    market === "cn-equity"
      ? String(initialStop ?? "")
      : (stopDraft ?? String(saved.data?.stop ?? ""));
  const target = targetDraft ?? String(saved.data?.target ?? "");
  const trailing =
    trailingDraft ??
    (saved.data?.trailing ? String(saved.data.trailing * 100) : "");
  const sleeve = sleeveDraft ?? saved.data?.sleeve ?? "swing";
  const [message, setMessage] = useState("");
  const mutation = api.saveHoldingAlert.useMutation({
    onSuccess: () => {
      setMessage("保护规则已保存；引擎按当前模式检查完成bar，仅提醒");
      void utils.holdingAlert.invalidate();
      void utils.tradeWorkspacePositions.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate({
          market,
          symbol,
          account,
          stop: stop ? Number(stop) : null,
          target: target ? Number(target) : null,
          trailing: trailing ? Number(trailing) / 100 : null,
          sleeve,
        });
      }}
    >
      {market === "crypto" && (
        <LedgerInput
          label={`${symbol} 提醒止损`}
          value={stop}
          onChange={setStop}
        />
      )}
      <LedgerInput
        label={`${symbol} 提醒目标`}
        value={target}
        onChange={setTarget}
      />
      <LedgerInput
        label={`${symbol} 移动止损%`}
        value={trailing}
        onChange={setTrailing}
      />
      <LedgerInput
        label={`${symbol} 所属分仓`}
        value={sleeve}
        onChange={setSleeve}
      />
      <Button disabled={mutation.isPending}>保存持仓提醒</Button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
