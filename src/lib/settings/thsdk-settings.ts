import { z } from "zod";

export const thsdkAuthModes = ["account", "qrcode", "guest"] as const;
export type ThsdkAuthMode = (typeof thsdkAuthModes)[number];

export const thsdkConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    dllPath: z.string().trim().max(260).optional(),
    allowUnlistedHash: z.boolean().optional(),
    allowAutoFallback: z.boolean().optional(),
    authMode: z.enum(thsdkAuthModes).optional(),
    guestModeEnabled: z.boolean().optional(),
  })
  .strict();
export type ThsdkConfigPatch = z.infer<typeof thsdkConfigPatchSchema>;

export const thsdkCredentialsInputSchema = z
  .object({
    username: z.string().trim().min(1, "请输入账号").max(120),
    password: z.string().min(1, "请输入密码").max(200),
  })
  .strict();
export type ThsdkCredentialsInput = z.infer<typeof thsdkCredentialsInputSchema>;

export type ThsdkStatusView = {
  enabled: boolean;
  configured: boolean;
  dllPath: string;
  dllKnownVersion: string | null;
  allowUnlistedHash: boolean;
  allowAutoFallback: boolean;
  authMode: ThsdkAuthMode;
  guestModeEnabled: boolean;
  hasSavedCredentials: boolean;
  state:
    | "unconfigured"
    | "disabled"
    | "logged_out"
    | "qr_pending"
    | "authenticated"
    | "error";
  activeMode: ThsdkAuthMode | null;
  authGeneration: number;
  configRevision: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  circuitOpenUntil: number | null;
  updatedAt: number;
};
