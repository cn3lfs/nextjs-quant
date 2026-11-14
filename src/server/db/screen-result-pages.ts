import type Database from "better-sqlite3";
import { sqlite } from "./index";
import { screenSortSchema } from "~/lib/screening/screen-sort";
import {
  matchesScreenCandidate,
  type pageScreenResults,
} from "../screening/screen-results";

type PageInput = Parameters<typeof pageScreenResults>[1];
type ResultPage = ReturnType<typeof pageScreenResults>;
const registered = new WeakSet<Database.Database>();
function registerSearch(database: Database.Database) {
  if (registered.has(database)) return;
  // SQLite lower() is ASCII-only. Reuse the existing Unicode/name-fallback
  // semantics while transferring only the two searchable fields to JS.
  database.function(
    "screen_candidate_matches",
    { deterministic: true },
    (symbol: string, name: string, query: string, currentName: string | null) =>
      Number(
        matchesScreenCandidate(
          { symbol, name },
          query,
          currentName === null ? {} : { [symbol]: currentName },
        ),
      ),
  );
  registered.add(database);
}

const sourceSql = `WITH job AS MATERIALIZED (
    SELECT jsonb(payload) document FROM records WHERE kind='job' AND id=@id
  ), source AS MATERIALIZED (
    SELECT document FROM job WHERE json_extract(document,'$.type')='screen'
      AND json_extract(document,'$.input.type')='formula-screen'
      AND json_extract(document,'$.status')='completed'
      AND json_type(document,'$.result')='object'
  )`;

/** SQLite parses stored JSON, but JS receives only metadata and up to 50 rows
 * per category. One statement materializes JSONB once for all three categories
 * and counts; no schema change or full result object is transferred to JS. */
export function readScreenResultPage(
  id: string,
  input: PageInput,
  currentNames: Record<string, string> = {},
): (ResultPage & { jobId: string }) | null {
  for (const page of [input.page, input.excludedPage, input.errorPage]) {
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page > Math.floor(Number.MAX_SAFE_INTEGER / 50)
    )
      throw new Error("选股结果页码无效");
  }
  const sort = screenSortSchema.parse(input.sort ?? "original");
  const direction = input.direction ?? "desc";
  if (direction !== "asc" && direction !== "desc")
    throw new Error("选股排序方向无效");
  const database = sqlite();
  registerSearch(database);
  const query = input.query.trim().toLowerCase();
  const params = query
    ? { id, query, names: JSON.stringify(currentNames) }
    : { id };
  const symbol = "json_extract(c.value,'$.symbol')";
  const filter = query
    ? `screen_candidate_matches(${symbol},json_extract(c.value,'$.name'),@query,n.value)`
    : "1";
  const from = `FROM source r, json_each(r.document,'$.result.candidates') c
    ${query ? `LEFT JOIN current_names n ON n.key=${symbol}` : ""} WHERE ${filter}`;
  // Expand the name directory once: repeated JSON object lookup for every
  // candidate is quadratic. SQLite can index this materialized key/value set.
  // Reuse filtered rows for both the count and page (including Unicode search).
  const filteredSql = query
    ? `, current_names AS MATERIALIZED (SELECT key,value FROM json_each(@names)),
    filtered AS MATERIALIZED (
      SELECT c.value, CAST(c.key AS INTEGER) position ${from}
    )`
    : "";
  const candidateFrom = query ? "FROM filtered c" : from;
  const position = query ? "c.position" : "CAST(c.key AS INTEGER)";
  let order = position;
  if (sort === "symbol") order = `${symbol} ${direction}, ${position}`;
  else if (sort !== "original") {
    // sort is a validated enum, never user SQL. Missing/nonfinite metrics sort
    // last in both directions, then by code and archived array position.
    const metric = `json_extract(c.value,'$.metrics.${sort}')`;
    const valid = `(json_type(c.value,'$.metrics.${sort}') IN ('integer','real')
      AND abs(${metric}) <= 1.7976931348623157e308)`;
    order = `coalesce(${valid},0) DESC, CASE WHEN ${valid} THEN ${metric} END ${direction}, ${symbol}, ${position}`;
  }
  const category = (key: "excluded" | "errors", offset: string) =>
    `(SELECT json_group_array(json(value)) FROM (
      SELECT c.value FROM source r, json_each(r.document,'$.result.${key}') c
      ORDER BY CAST(c.key AS INTEGER) LIMIT 50 OFFSET ${offset}
    ))`;
  const row = database
    .prepare(
      `${sourceSql}${filteredSql}
    SELECT json_object(
      'formula',json_extract(document,'$.result.formula'),
      'adjustment',coalesce(json_extract(document,'$.result.adjustment'),'none'),
      'total',json_extract(document,'$.result.total'),
      'asOf',json_extract(document,'$.result.asOf'),
      'elapsedMs',json_extract(document,'$.result.elapsedMs'),
      'period',json_extract(document,'$.result.period'),
      'researchMode',json_extract(document,'$.result.researchMode'),
      'universeSource',json_extract(document,'$.result.universeSource'),
      'researchWarnings',json_extract(document,'$.result.researchWarnings'),
      'candidateTotal',json_array_length(document,'$.result.candidates'),
      'excludedTotal',json_array_length(document,'$.result.excluded'),
      'errorTotal',json_array_length(document,'$.result.errors'),
      'count',${query ? "(SELECT count(*) FROM filtered)" : "json_array_length(document,'$.result.candidates')"},
      'candidates',json((SELECT json_group_array(json(value)) FROM (
        SELECT c.value ${candidateFrom} ORDER BY ${order} LIMIT 50 OFFSET @offset
      ))),
      'excluded',json(${category("excluded", "@excludedOffset")}),
      'errors',json(${category("errors", "@errorOffset")})
    ) AS page FROM source`,
    )
    .get({
      ...params,
      offset: input.page * 50,
      excludedOffset: input.excludedPage * 50,
      errorOffset: input.errorPage * 50,
    }) as { page: string } | undefined;
  if (!row) return null;
  const result = JSON.parse(row.page) as Omit<ResultPage, "sort" | "direction">;
  if (
    ![result.candidateTotal, result.excludedTotal, result.errorTotal].every(
      Number.isSafeInteger,
    )
  )
    throw new Error("选股结果缺少有效的分类数组");
  return { jobId: id, ...result, sort, direction };
}
