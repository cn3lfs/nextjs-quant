import { z } from "zod";
export const symbolSchema = z.string().regex(/^(sh|sz|bj)\d{6}$/);
