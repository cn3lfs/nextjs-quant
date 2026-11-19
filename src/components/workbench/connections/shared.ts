import type { ReactNode } from "react";
import type { Channel } from "~/lib/domain";
import type { RouterOutputs } from "~/trpc/react";

export type FieldProps = (name: string) => {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby": string | undefined;
};
export type FieldError = (name: string) => ReactNode;
export type ChannelDraft = {
  name: string;
  type: Channel["type"];
  target: string;
  thread: string;
  secret: string;
  signingSecret: string;
  enabled: boolean;
};
export type NewsBudget = {
  data?: { used: number; limit: number; day: string; exhausted?: boolean };
  error: { message?: string } | null;
};
export type SkillCatalog = {
  data?: RouterOutputs["researchSkills"];
  error: { message: string } | null;
};
export type Coverage = {
  counts: Record<string, number>;
  scannedAt: number;
  total: number;
};
