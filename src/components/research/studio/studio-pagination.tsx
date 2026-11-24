import { Button } from "~/components/ui/button";

export function DiagnosePagination({
  page,
  hasNext,
  onPageChange,
  label,
}: {
  page: number;
  hasNext: boolean;
  onPageChange: (page: number) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        上一页
      </Button>
      <span className="text-nc-text-3 tabular-nums">
        {label ?? `第 ${page} 页`}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!hasNext || page >= 1_000_000}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}

/** Shared renderer for one archive page: comparison, checks and disclosures. */
