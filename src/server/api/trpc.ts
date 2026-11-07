import { initTRPC, TRPCError } from "@trpc/server";
import {
  deprecatedStrategyOperations,
  deprecatedStrategyMessage,
} from "~/lib/backtest/strategy-lifecycle";
import superjson from "superjson";
import { ZodError } from "zod";
export const createTRPCContext = async (opts: { headers: Headers }) => opts;
const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});
export const createCallerFactory = t.createCallerFactory;
export const createTRPCRouter = t.router;
export const mergeTRPCRouters = t.mergeRouters;
export const publicProcedure = t.procedure.use(async ({ path, next }) => {
  const name = path.split(".").at(-1)!;
  if (deprecatedStrategyOperations.has(name))
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: deprecatedStrategyMessage,
    });
  return next();
});
