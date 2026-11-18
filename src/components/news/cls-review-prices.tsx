"use client";
import { formatEvidenceText } from "~/lib/common/evidence-text";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../ui/table";
import { ClsSelect } from "./cls-review-fields";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClsReviewText } from "./cls-review-text";
import { api } from "~/trpc/react";
import { clsReviewDate } from "~/lib/news/cls-review-workspace";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  ClsError,
  ClsPages,
  clsDirections,
  clsPct,
  clsTime,
} from "./cls-review-fields";
/** One opened verification, bound to the exact date and full hash it came from. */
type ClsEvidenceIdentity = { date: string; hash: string; checkedAt: number };
const clsEvidenceHash = /^[a-f0-9]{64}$/;

export function ClsReviewPrices({
  reportId,
  visible,
  initialDate,
  openOwnerReport,
}: {
  reportId: string;
  visible: boolean;
  initialDate: string;
  openOwnerReport: (ownerId: string, date: string) => void;
}) {
  const utils = api.useUtils();
  const eligibility = api.clsReviewSampleEligibility.useQuery(reportId, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const related = api.clsReviewReportSamples.useQuery(reportId, {
    enabled: visible,
  });
  const [date, setDate] = useState(initialDate),
    [dateDraft, setDateDraft] = useState(initialDate);
  const dateRef = useRef(date);
  dateRef.current = date;
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [chosen, setChosen] = useState(""),
    [opened, setOpened] = useState<ClsEvidenceIdentity | null>(null),
    [receipt, setReceipt] = useState<ClsEvidenceIdentity | null>(null),
    [identityError, setIdentityError] = useState(""),
    [feedback, setFeedback] = useState("");
  function chooseDate(value: string) {
    setDate(value);
    setDateDraft(value);
    setPages([undefined]);
    setChosen("");
    setOpened(null);
  }
  useEffect(() => {
    if (!date && related.data?.[0]) {
      setDate(related.data[0].date);
      setDateDraft(related.data[0].date);
    }
  }, [date, related.data]);
  const valid = clsReviewDate.safeParse(date).success;
  const sample = api.clsReviewSample.useQuery(date || "2000-01-01", {
    enabled: visible && valid,
    gcTime: 0,
  });
  const versions = api.clsReviewVerificationPage.useQuery(
    { date: date || "2000-01-01", cursor: pages.at(-1) },
    { enabled: visible && valid, gcTime: 0 },
  );
  const current = chosen
    ? versions.data?.items.find((row) => row.hash === chosen)
    : versions.data?.items[0];
  // Only an explicitly opened identity is read, and only on the visible prices
  // tab. The exact date/hash pair is the sole query input.
  const detail = api.clsReviewVerificationDetail.useQuery(
    {
      date: opened?.date ?? "2000-01-01",
      hash: opened?.hash ?? "0".repeat(64),
    },
    { enabled: visible && !!opened, gcTime: 0 },
  );
  const detailMatches =
    !!opened &&
    !!detail.data &&
    detail.data.date === opened.date &&
    detail.data.hash === opened.hash;
  const evidenceText = useMemo(
    () => (detailMatches ? formatEvidenceText(detail.data) : ""),
    [detail.data, detailMatches],
  );
  // Only the sample for the exact queried day may drive ownership and the
  // cross-report jump; never a previous day's value or a stale cached owner.
  const currentSample =
    sample.data && sample.data.date === date ? sample.data : null;
  const otherOwner =
    !!currentSample &&
    currentSample.reportAvailable &&
    currentSample.reportId !== reportId;
  const ownerCleared = !!currentSample && !currentSample.reportAvailable;
  const canJump = otherOwner && !sample.isFetching && !sample.error;
  const verify = api.clsReviewVerify.useMutation({
    gcTime: 0,
    onMutate: () => setIdentityError(""),
    onSuccess: (result, submittedDate) => {
      void utils.clsReviewVerificationPage.invalidate(
        { date: submittedDate },
        { refetchType: "active" },
      );
      void utils.clsReviewSummary.invalidate(undefined, {
        refetchType: "active",
      });
      // The receipt must describe what the server actually saved. A mismatch
      // keeps the previous receipt and reports only this identity failure.
      if (result.date !== submittedDate) {
        setIdentityError(
          `核对回执身份校验失败：返回日期 ${result.date} 与提交日期 ${submittedDate} 不一致，保留上一次回执。`,
        );
        return;
      }
      if (!clsEvidenceHash.test(result.hash)) {
        setIdentityError(
          "核对回执身份校验失败：返回版本摘要格式无效，保留上一次回执。",
        );
        return;
      }
      if (
        typeof result.checkedAt !== "number" ||
        result.checkedAt <= 0 ||
        !Number.isFinite(new Date(result.checkedAt).getTime())
      ) {
        setIdentityError(
          "核对回执身份校验失败：返回保存时间无效，保留上一次回执。",
        );
        return;
      }
      setIdentityError("");
      setReceipt({
        date: result.date,
        hash: result.hash,
        checkedAt: result.checkedAt,
      });
    },
  });
  const fix = api.clsReviewFixSample.useMutation({
    gcTime: 0,
    onMutate: () => ({ date: dateRef.current }),
    onSuccess: (value, _, context) => {
      void utils.clsReviewReportSamples.invalidate(reportId, {
        refetchType: "active",
      });
      void utils.clsReviewSample.invalidate(value.date, {
        refetchType: "active",
      });
      setFeedback(
        `样本日期 ${value.date}，归属 ${value.reportId === reportId ? "本报告" : "另一报告（保留既有选样）"}`,
      );
      void utils.clsReviewSampleEligibility.invalidate(reportId, {
        refetchType: "active",
      });
      if (dateRef.current === context?.date) chooseDate(value.date);
    },
  });
  return (
    <section className="space-y-4" aria-label="固定样本与价格观察">
      <p className="text-sm text-nc-text-3">
        固定样本按实际选样时间判定，不能盘后补选。价格方向观察与事实支持率独立；未复权观察不属于可执行策略业绩。
      </p>
      <Button
        disabled={
          fix.isPending || !eligibility.data?.allowed || !!eligibility.error
        }
        onClick={() => fix.mutate(reportId)}
      >
        用此报告固定今日盘前样本
      </Button>
      <p className="text-xs text-nc-text-3">
        {eligibility.data?.reason ?? "正在检查当前选样条件…"}
      </p>
      <ClsError error={fix.error} />
      <ClsError
        error={eligibility.error}
        retry={() => void eligibility.refetch()}
      />
      <ClsError error={related.error} retry={() => void related.refetch()} />
      <div className="flex flex-wrap gap-2">
        <span className="text-sm">本报告关联样本：</span>
        {related.data?.length === 0 && <span className="text-sm">暂无</span>}
        {related.data?.map((row) => (
          <Button
            key={row.date}
            size="sm"
            variant={row.date === date ? "default" : "outline"}
            onClick={() => chooseDate(row.date)}
          >
            {row.date}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (clsReviewDate.safeParse(dateDraft).success) chooseDate(dateDraft);
        }}
      >
        <label className="text-sm">
          独立按日查询
          <Input
            type="date"
            value={dateDraft}
            onChange={(event) => setDateDraft(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          disabled={!clsReviewDate.safeParse(dateDraft).success}
        >
          查询样本日期
        </Button>
      </form>
      <p role="status" className="text-sm">
        {feedback}
      </p>
      <ClsError error={sample.error} retry={() => void sample.refetch()} />
      {valid && sample.isLoading && <p>正在读取样本…</p>}
      {valid && sample.data === null && <p>该日尚无固定样本，不能事后补选。</p>}
      {currentSample && (
        <div className="space-y-2 rounded border border-nc-border-soft p-3 text-sm">
          <p>
            样本日期 {currentSample.date} · 固定于{" "}
            {clsTime(currentSample.fixedAt)}
          </p>
          <p>
            归属：
            {currentSample.reportId === reportId ? "当前报告" : "另一报告"}
          </p>
          {ownerCleared ? (
            <p className="text-nc-warn">所属报告已清理，样本日期占位保留。</p>
          ) : (
            <p>
              {currentSample.selected?.symbol ?? "无选中证券"} ·{" "}
              {clsDirections[currentSample.selected?.direction ?? "unknown"]} ·{" "}
              {currentSample.reason ?? currentSample.selected?.evidence}
            </p>
          )}
          {!ownerCleared && (
            <div className="flex flex-wrap gap-2">
              {otherOwner && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canJump}
                  onClick={() =>
                    openOwnerReport(currentSample.reportId, currentSample.date)
                  }
                >
                  查看样本所属报告
                </Button>
              )}
              <Button
                size="sm"
                disabled={
                  verify.isPending || sample.isFetching || !!sample.error
                }
                onClick={() => verify.mutate(date)}
              >
                {verify.isPending ? "正在读取行情…" : "读取行情并核对"}
              </Button>
            </div>
          )}
        </div>
      )}
      <ClsError error={verify.error} />
      {identityError && (
        <p role="alert" className="text-sm text-nc-bad">
          {identityError}
        </p>
      )}
      {receipt && (
        <div className="space-y-2 rounded border border-nc-border-soft p-3 text-sm">
          <p>
            最近一次成功核对：{receipt.date} · 版本 {receipt.hash.slice(0, 10)}{" "}
            · 保存于 {clsTime(receipt.checkedAt)}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpened({ ...receipt })}
          >
            查看本次核对证据
          </Button>
        </div>
      )}
      <ClsError error={versions.error} retry={() => void versions.refetch()} />
      {valid && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={versions.isFetching}
            onClick={() => {
              setChosen("");
              setOpened(null);
              if (pages.length > 1) setPages([undefined]);
              else void versions.refetch();
            }}
          >
            刷新至最新核对
          </Button>
          <label className="block text-sm">
            价格核对版本
            <ClsSelect
              label="价格核对版本"
              value={current?.hash ?? ""}
              onChange={(value) => {
                setChosen(value);
                setOpened(null);
              }}
              placeholder="尚无核对"
              options={(versions.data?.items ?? []).map((row, index) => ({
                value: row.hash,
                label: `${pages.length === 1 && index === 0 ? "最新" : "历史"} · ${clsTime(row.checkedAt)} · ${row.hash.slice(0, 10)}`,
              }))}
            />
          </label>
          <ClsPages
            count={pages.length}
            more={versions.data?.hasMore ?? false}
            busy={versions.isFetching || !!versions.error}
            previous={() => {
              setPages((value) => value.slice(0, -1));
              setChosen("");
              setOpened(null);
            }}
            next={() => {
              if (versions.data?.nextCursor) {
                setPages((value) => [...value, versions.data.nextCursor!]);
                setChosen("");
                setOpened(null);
              }
            }}
          />
        </>
      )}
      {opened && (
        <div className="space-y-2 rounded border border-nc-border-soft p-3 text-sm">
          <p>
            所查核对：日期 {opened.date} · 版本 {opened.hash.slice(0, 10)} ·
            保存于 {clsTime(opened.checkedAt)}
          </p>
          <Button size="sm" variant="outline" onClick={() => setOpened(null)}>
            收起核对证据
          </Button>
          {detail.error ? (
            <ClsError
              error={detail.error}
              retry={() => void detail.refetch()}
            />
          ) : detail.isLoading ? (
            <p>正在读取证据…</p>
          ) : detailMatches ? (
            <ClsReviewText
              key={`${opened.date}:${opened.hash}`}
              text={evidenceText}
              label="核对证据"
            />
          ) : detail.data ? (
            <p>核对证据身份不一致，未显示；请重新打开。</p>
          ) : detail.data === null ? (
            <p>该版本已不存在，可能所属报告已清理。</p>
          ) : (
            <p>正在读取证据…</p>
          )}
        </div>
      )}
      {current && (
        <div className="space-y-2 text-sm">
          <p>
            行情来源：{current.source.root} · 基准 {current.source.benchmark} ·
            未复权
          </p>
          {current.warnings.map((warning) => (
            <p key={warning} className="text-nc-warn">
              {warning}
            </p>
          ))}
          <div className="overflow-x-auto">
            <Table className="w-full text-left text-xs">
              <TableHeader>
                <TableRow>
                  {[
                    "窗口",
                    "截止日期",
                    "股票收益",
                    "基准收益",
                    "超额收益",
                    "方向",
                    "状态 / 说明",
                  ].map((label) => (
                    <TableHead className="p-2 whitespace-nowrap" key={label}>
                      {label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {current.outcomes.map((row) => (
                  <TableRow
                    key={row.horizon}
                    className="border-t border-nc-border-soft"
                  >
                    <TableCell className="p-2">
                      {row.horizon ? `T+${row.horizon}` : "当日"}
                    </TableCell>
                    <TableCell>{row.exitDate ?? "—"}</TableCell>
                    <TableCell>{clsPct(row.grossReturn)}</TableCell>
                    <TableCell>{clsPct(row.benchmarkReturn)}</TableCell>
                    <TableCell>{clsPct(row.excessReturn)}</TableCell>
                    <TableCell>
                      {row.hit === null ? "—" : row.hit ? "命中" : "未命中"}
                    </TableCell>
                    <TableCell>
                      {row.status === "pending"
                        ? "待观察"
                        : row.status === "unavailable"
                          ? "缺价 / 无样本"
                          : "已观察"}{" "}
                      · {row.reason ?? "观察完成"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const identity = {
                date,
                hash: current.hash,
                checkedAt: current.checkedAt,
              };
              setOpened((value) =>
                value?.date === identity.date && value?.hash === identity.hash
                  ? null
                  : identity,
              );
            }}
          >
            {opened?.date === date && opened?.hash === current.hash
              ? "收起完整核对证据"
              : "读取完整核对证据"}
          </Button>
        </div>
      )}
    </section>
  );
}
