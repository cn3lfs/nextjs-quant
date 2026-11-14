import { initTRPC, TRPCError } from "@trpc/server";
import {
  capabilities,
  capabilityAllows,
  isCapabilityBinding,
  type CapabilityBinding,
  type CapabilityId,
  type CapabilityOperation,
} from "~/lib/common/capabilities";
import superjson from "superjson";
import { ZodError } from "zod";
export const createTRPCContext = async (opts: { headers: Headers }) => opts;
const t = initTRPC
  .context<typeof createTRPCContext>()
  .meta<CapabilityBinding>()
  .create({
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
const declaredProcedure = t.procedure.use(async ({ meta, next }) => {
  if (!isCapabilityBinding(meta))
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "接口未声明有效能力",
    });
  if (!capabilityAllows(meta.capability, meta.operation))
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: capabilities[meta.capability].reason || "此能力不允许该操作",
    });
  return next();
});
// No default binding: new read and execution routes must declare their policy.
export const capabilityProcedure = (
  capability: CapabilityId,
  operation: CapabilityOperation,
) => declaredProcedure.meta({ capability, operation });
