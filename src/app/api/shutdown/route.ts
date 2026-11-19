import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { NextRequest } from "next/server";
import { thsdkShutdown } from "~/server/data-sources/thsdk/thsdk-client";
import { dataDirectory } from "~/server/db";

export const runtime = "nodejs";

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export async function POST(request: NextRequest) {
  const expected = process.env.QUANT_SESSION_TOKEN;
  const origin = request.headers.get("origin");
  if (
    !expected ||
    (origin && origin !== `http://${request.headers.get("host")}`) ||
    ![
      request.headers.get("x-quant-session"),
      request.cookies.get("quant-session")?.value,
    ].some((value) => value && timingSafeEqual(digest(value), digest(expected)))
  )
    return new Response("Forbidden", { status: 403 });

  const shutdownBudgetMs = 1_200;
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      thsdkShutdown(shutdownBudgetMs).catch(() => {}),
      new Promise<void>((resolve) => {
        shutdownDeadline = setTimeout(resolve, shutdownBudgetMs);
      }),
    ]);
  } finally {
    clearTimeout(shutdownDeadline);
  }

  let connection: Database.Database | undefined;
  try {
    // Shutdown must never create or migrate a database. Bound time spent on a busy WAL.
    connection = new Database(join(dataDirectory(), "quant.sqlite"), {
      fileMustExist: true,
      timeout: 250,
    });
    connection.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // A missing database or active reader cannot prevent the service from exiting.
  } finally {
    connection?.close();
  }
  setTimeout(() => process.exit(0), 80);
  return Response.json({ status: "shutting-down" });
}
