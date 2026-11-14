"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

/** Resolve bookmarked task identity without replaying navigation on query updates. */
export function ScreenRouteSelection({
  selectJob,
}: {
  selectJob: (id: string) => void;
}) {
  const search = useSearchParams();
  const id = search.get("job");
  const select = useRef(selectJob);
  select.current = selectJob;
  useEffect(() => {
    if (id) select.current(id);
  }, [id]);
  return null;
}
