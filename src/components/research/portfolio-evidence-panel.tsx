"use client";
import { useState } from "react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  labPortfolioEvidenceMaxBatchBytes,
  labPortfolioEvidenceMaxFileBytes,
  labPortfolioEvidenceMaxFiles,
  type LabPortfolioCandidateRole,
  type TenPositionRegistrationVersion,
} from "~/lib/research/lab-portfolio-evidence";

type EvidenceListItem =
  RouterOutputs["strategyLabPortfolioEvidenceList"][number];
type EvidenceDetail = NonNullable<
  RouterOutputs["strategyLabPortfolioEvidenceDetail"]
>;
type RegistrationDetail = Extract<EvidenceDetail, { type: "registration" }>;
type CheckpointDetail = Extract<EvidenceDetail, { type: "checkpoint" }>;

const statusLabels = {
  completed: "证据行已导入",
  blocked: "blocked（不构成成功证据）",
  partial: "部分导入",
  pending: "尚无检查点",
} as const;

const marketLabels = {
  "cn-equity": "A股",
  crypto: "BTC / ETH",
} as const;

const versionLabels: Record<TenPositionRegistrationVersion, string> = {
  "theory-study-ten-2": "v2（冻结身份）",
  "theory-study-ten-3": "v3（完整执行依赖）",
};

const roleLabels: Record<LabPortfolioCandidateRole, string> = {
  "entry-experiment": "入场实验",
  "source-exit": "原始出场",
  proxy: "代理",
  protected: "保护版代理",
  unbound: "未绑定",
};

const pct = (value: number | null | undefined) =>
  formatPercent(value == null ? null : value * 100);

function timestamp(value: number) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ") + "Z";
}

function EvidenceItems({
  items,
  onOpen,
}: {
  items: readonly EvidenceListItem[];
  onOpen: (hash: string) => void;
}) {
  if (!items.length)
    return <p className="text-sm text-nc-text-3">尚未导入十持仓登记文件。</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>登记身份</TableHead>
          <TableHead>版本</TableHead>
          <TableHead>市场</TableHead>
          <TableHead>预期 / 已导入</TableHead>
          <TableHead>完成 / blocked / 缺失</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>详情</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.identity}>
            <TableCell className="font-mono">
              {item.identity.slice(0, 12)}…
            </TableCell>
            <TableCell>{versionLabels[item.version]}</TableCell>
            <TableCell>
              {item.markets.map((m) => marketLabels[m]).join("、")}
            </TableCell>
            <TableCell>
              {item.expectedCheckpoints} / {item.checkpoints.total}
            </TableCell>
            <TableCell>
              {item.checkpoints.completed} / {item.checkpoints.blocked} /{" "}
              {item.checkpoints.missing}
            </TableCell>
            <TableCell>{statusLabels[item.status]}</TableCell>
            <TableCell>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpen(item.identity)}
              >
                查看
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RegistrationPanel({
  detail,
  onOpen,
}: {
  detail: RegistrationDetail;
  onOpen: (hash: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">登记详情</h3>
      <p className="text-sm">
        {detail.identity} · {timestamp(detail.importedAt)} · {detail.filename}
      </p>
      <p className="text-sm">
        登记版本：{versionLabels[detail.registration.version]} ·{" "}
        {detail.registration.version}
      </p>
      <p className="text-sm">
        十持仓：最多 {detail.registration.account.maxPositions}{" "}
        个品种、单品种目标 {pct(detail.registration.account.targetWeight)} ·
        市场{" "}
        {detail.registration.markets.map((m) => marketLabels[m]).join("、")}
      </p>
      <p className="text-sm">
        窗口：
        {detail.registration.windows
          .map((w) => `${w.label}（${w.start} 至 ${w.end}）`)
          .join("；")}
      </p>
      <p className="text-sm">
        成本情景：{detail.registration.scenarios.join("、")} · 候选{" "}
        {detail.registration.candidates.length} 个
        {detail.registration.includeBaseline ? " + baseline" : ""}
      </p>
      <details>
        <summary>候选策略（按集中绑定区分角色）</summary>
        <ul className="text-sm">
          {detail.candidateRoles.map((candidate) => (
            <li key={candidate.strategyId}>
              {candidate.strategyId} · {roleLabels[candidate.role]}
              {candidate.preset ? ` · ${candidate.preset}` : ""}
            </li>
          ))}
        </ul>
      </details>
      <p>
        预期检查点 {detail.expectedCheckpoints} · 已导入 {detail.counts.total} ·
        完成 {detail.counts.completed} · blocked {detail.counts.blocked} · 缺失{" "}
        {detail.counts.missing} · {statusLabels[detail.status]}
      </p>
      <div className="max-h-80 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>市场</TableHead>
              <TableHead>策略</TableHead>
              <TableHead>窗口</TableHead>
              <TableHead>情景</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.checkpoints.map((checkpoint) => (
              <TableRow key={checkpoint.evidenceId} className="align-top">
                <TableCell>{marketLabels[checkpoint.key.market]}</TableCell>
                <TableCell>{checkpoint.key.strategyId}</TableCell>
                <TableCell>{checkpoint.key.window}</TableCell>
                <TableCell>{checkpoint.key.scenario}</TableCell>
                <TableCell>{roleLabels[checkpoint.role]}</TableCell>
                <TableCell className="whitespace-normal">
                  {checkpoint.status === "blocked"
                    ? `blocked：${checkpoint.reason ?? "未记录原因"}`
                    : "completed"}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpen(checkpoint.contentHash)}
                  >
                    按哈希
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CheckpointPanel({
  detail,
  onOpen,
}: {
  detail: CheckpointDetail;
  onOpen: (hash: string) => void;
}) {
  const registration = detail.registration;
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">检查点详情</h3>
      <p className="text-sm">
        {detail.identity} · {detail.key.market} · {detail.key.strategyId} ·{" "}
        {detail.key.window} · {detail.key.scenario}
      </p>
      <p className="text-sm">策略角色：{roleLabels[detail.role]}</p>
      <p>
        状态：
        {detail.status === "blocked"
          ? `blocked（${detail.reason ?? "未记录原因"}）`
          : "completed"}
        {" · "}内容哈希 {detail.contentHash}
      </p>
      {registration && (
        <>
          <p className="text-sm">
            所属登记版本：{versionLabels[registration.version]}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpen(registration.identity)}
          >
            查看所属登记
          </Button>
        </>
      )}
      {detail.row.status === "blocked" ? (
        <p className="text-sm">
          blocked
          行只记录未完成原因，不含收益、成交或曲线证据，不能计作成功回放。
        </p>
      ) : (
        <div className="space-y-1 text-sm">
          <p>
            规则自检收益 {pct(detail.row.netReturn)} · 最大回撤{" "}
            {pct(detail.row.maxDrawdown)} · 收益/回撤{" "}
            {formatNumber(detail.row.returnToDrawdown, 3)}
          </p>
          <p>
            买入 {detail.row.buys} · 卖出 {detail.row.sells} · 拒单{" "}
            {detail.row.rejections} · 观察 {detail.row.observations} · 峰值持仓{" "}
            {detail.row.peakPositions} / 10
          </p>
          <p>
            费用 {formatNumber(detail.row.fees, 2)} · 成交额{" "}
            {formatNumber(detail.row.turnoverNotional, 2)} · 质量{" "}
            {detail.row.quality}
          </p>
        </div>
      )}
    </div>
  );
}

/** Read-only view of explicitly imported ten-position research artifacts.
 * Importing never registers/promotes a strategy or changes shadow/live state. */
export function PortfolioEvidencePanel() {
  const [selected, setSelected] = useState<{ name: string; content: string }[]>(
    [],
  );
  const [fileError, setFileError] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [hashInput, setHashInput] = useState("");
  const [hashError, setHashError] = useState("");
  const [detailHash, setDetailHash] = useState<string | null>(null);
  const visible = usePanelVisible();
  const list = api.strategyLabPortfolioEvidenceList.useQuery(undefined, {
    enabled: visible,
    retry: false,
  });
  const detail = api.strategyLabPortfolioEvidenceDetail.useQuery(
    { hash: detailHash ?? "" },
    { enabled: visible && detailHash !== null, retry: false },
  );
  const importEvidence = api.strategyLabPortfolioEvidenceImport.useMutation({
    onSuccess: () => {
      setSelected([]);
      setFileError("");
      setInputKey((key) => key + 1);
      void list.refetch();
      if (detailHash) void detail.refetch();
    },
  });
  async function choose(files: FileList | null) {
    setFileError("");
    importEvidence.reset();
    const picked = Array.from(files ?? []);
    if (!picked.length) {
      setSelected([]);
      return;
    }
    if (picked.length > labPortfolioEvidenceMaxFiles) {
      setFileError(`一次最多导入 ${labPortfolioEvidenceMaxFiles} 个文件`);
      return;
    }
    try {
      const next: { name: string; content: string }[] = [];
      let total = 0;
      for (const file of picked) {
        if (file.size > labPortfolioEvidenceMaxFileBytes)
          throw new Error(`${file.name} 超过 8 MiB 限制`);
        total += file.size;
        if (total > labPortfolioEvidenceMaxBatchBytes)
          throw new Error("本批文件总大小超过 32 MiB 限制");
        next.push({ name: file.name, content: await file.text() });
      }
      setSelected(next);
    } catch (error) {
      setSelected([]);
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }
  function open(hash: string) {
    setHashInput(hash);
    setHashError("");
    setDetailHash(hash);
  }
  return (
    <section
      aria-label="十持仓研究证据"
      className="space-y-3 rounded border p-3"
    >
      <h2 className="text-lg font-semibold">十持仓研究证据（只读导入）</h2>
      <p className="text-sm">
        显式选择研究 CLI 生成的 registration-*.json 与检查点文件。服务端严格校验
        身份、键和行后持久保存；本入口只读证据，不登记或晋级策略、不改变空跑观察与正式提醒状态、不产生交易或通知。同键不同证据拒绝覆盖，blocked
        行保持 blocked。
      </p>
      <label className="block text-sm">
        <span className="mb-2 block">选择登记或检查点文件</span>
        <Input
          key={inputKey}
          aria-label="选择十持仓登记或检查点文件"
          type="file"
          multiple
          accept=".json,application/json"
          onChange={(event) => void choose(event.target.files)}
        />
      </label>
      {selected.length > 0 && (
        <ul className="text-sm">
          {selected.map((file, index) => (
            <li key={`${index}:${file.name}`}>
              {file.name} · {Math.ceil(file.content.length / 1024)} KiB
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        disabled={!selected.length || importEvidence.isPending}
        onClick={() => importEvidence.mutate({ files: selected })}
      >
        导入所选文件
      </Button>
      {fileError && <p role="alert">{fileError}</p>}
      {importEvidence.error && (
        <p role="alert">{importEvidence.error.message}</p>
      )}
      {importEvidence.data && (
        <ul role="status" className="text-sm">
          {importEvidence.data.map((result) => (
            <li key={result.name}>
              {result.name}：
              {result.status === "imported" ? "已导入" : "已存在（未改写）"} ·{" "}
              {result.kind === "registration"
                ? "登记"
                : `检查点 · ${roleLabels[result.role ?? "unbound"]}`}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^[a-f0-9]{64}$/.test(hashInput))
            return setHashError("请输入 64 位小写 SHA256");
          setHashError("");
          setDetailHash(hashInput);
        }}
      >
        <Input
          aria-label="十持仓证据哈希"
          placeholder="登记身份或检查点内容哈希（64位 SHA256）"
          value={hashInput}
          onChange={(event) => {
            setHashInput(event.target.value);
            setHashError("");
          }}
          maxLength={64}
          className="max-w-lg"
        />
        <Button type="submit">按哈希查看</Button>
      </form>
      {hashError && <p role="alert">{hashError}</p>}
      {list.isLoading && <p role="status">正在读取已导入证据…</p>}
      {list.error && (
        <p role="alert">
          {list.error.message}
          <Button
            type="button"
            variant="outline"
            onClick={() => void list.refetch()}
          >
            重试
          </Button>
        </p>
      )}
      <EvidenceItems items={list.data ?? []} onOpen={open} />
      {detailHash && detail.error && (
        <p role="alert">证据详情不可读：{detail.error.message}</p>
      )}
      {detailHash && detail.isFetching && (
        <p role="status">正在读取证据详情…</p>
      )}
      {detail.data?.type === "registration" && (
        <RegistrationPanel detail={detail.data} onOpen={open} />
      )}
      {detail.data?.type === "checkpoint" && (
        <CheckpointPanel detail={detail.data} onOpen={open} />
      )}
      {detailHash && !detail.isFetching && detail.data === null && (
        <p role="status">未找到该哈希对应的已导入证据。</p>
      )}
      <p className="text-sm text-nc-text-3">
        证据行仅作规则自检与继续追踪线索，不表示收益资格、独立留出或真实成交。
      </p>
    </section>
  );
}
