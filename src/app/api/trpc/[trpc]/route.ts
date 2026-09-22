import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { trustedRequest } from "~/server/infra/access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handler(req: NextRequest) {
  if (
    !trustedRequest(
      req.headers.get("host") ?? "",
      req.headers.get("origin"),
      req.headers.get("x-quant-client"),
      process.env.QUANT_SESSION_TOKEN,
      req.cookies.get("quant-session")?.value,
    )
  )
    return new Response("Forbidden", { status: 403 });
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
  });
}
export { handler as GET, handler as POST };
