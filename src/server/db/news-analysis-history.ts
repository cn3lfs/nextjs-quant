import type { NewsAnalysis } from "../news/news-analysis";
import { sqlite } from "./index";
import { readSnapshot } from "./snapshot";

/** The callback consumes one archive at a time in the same read snapshot.
 * Returning false stops a completed-item cache search without loading history. */
export function visitNewsAnalyses(
  model: string,
  method: NewsAnalysis["method"],
  visit: (archive: NewsAnalysis) => boolean | void,
) {
  return readSnapshot(() => {
    const rows = sqlite()
      .prepare(
        "SELECT payload FROM records WHERE kind='news-analysis' AND json_extract(payload,'$.model')=? AND json_extract(payload,'$.method')=? ORDER BY updated_at DESC,id DESC",
      )
      .iterate(model, JSON.stringify(method)) as Iterable<{ payload: string }>;
    for (const row of rows)
      if (visit(JSON.parse(row.payload) as NewsAnalysis) === false) break;
  });
}

export function newsAnalysesThrough(model: string, cutoff: number) {
  return readSnapshot(() => {
    const rows = sqlite()
      .prepare(
        "SELECT payload FROM records WHERE kind='news-analysis' AND json_extract(payload,'$.model')=? AND json_extract(payload,'$.input.cutoff')<=? ORDER BY id",
      )
      .iterate(model, cutoff) as Iterable<{ payload: string }>;
    return Array.from(rows, (row) => JSON.parse(row.payload) as NewsAnalysis);
  });
}
