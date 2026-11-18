"use client";
import Link from "next/link";
import type { PlanSavedConfirmation } from "../signals/candidate-plan";

/** Stable confirmation in the tomorrow-plan area after the dialog closes. */
export function PlanSavedNotice({
  confirmation,
}: {
  confirmation: PlanSavedConfirmation | null;
}) {
  if (!confirmation) return null;
  return (
    <p role="status">
      {confirmation.message} ·{" "}
      <Link
        className="underline"
        href={`/accounts/alerts?plan=${encodeURIComponent(confirmation.id)}`}
      >
        查看计划
      </Link>
    </p>
  );
}
