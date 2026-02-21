import { z } from "zod";

export const PairCreateResponseSchema = z.object({
  pairId: z.string().min(1),
  code: z.string().min(6),
  expiresAt: z.string().datetime(),
  pairingUrl: z.string().url(),
});

export const PairClaimRequestSchema = z.object({
  pairId: z.string().min(1),
  code: z.string().min(1),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
});

export const ServerInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

export const PairClaimResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  serverInfo: ServerInfoSchema,
});

export const AuthRefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const AuthRefreshResponseSchema = z.object({
  accessToken: z.string().min(1),
});

export const AuthLogoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const ThreadSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  title: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const ThreadsResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema),
});

export const ThreadResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  title: z.string().optional(),
  turns: z.array(z.unknown()),
});

export const ThreadResumeResponseSchema = z.object({
  ok: z.literal(true),
});

export const ThreadCreateResponseSchema = z.object({
  ok: z.literal(true),
  threadId: z.string().min(1),
});

export const ThreadMessageRequestSchema = z.object({
  text: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

export const ThreadMessageResponseSchema = z.object({
  ok: z.literal(true),
  turnId: z.string().optional(),
});

export const ModelOptionSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  label: z.string().min(1),
  isDefault: z.boolean(),
  supportedReasoningEfforts: z.array(z.enum(["none", "minimal", "low", "medium", "high", "xhigh"])),
  defaultReasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

export const GatewayOptionsResponseSchema = z.object({
  models: z.array(ModelOptionSchema),
  defaultModel: z.string().optional(),
  defaultReasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  codexReachable: z.boolean(),
  gatewayVersion: z.string().min(1),
  codexError: z.string().optional(),
});

export type PairCreateResponse = z.infer<typeof PairCreateResponseSchema>;
export type PairClaimRequest = z.infer<typeof PairClaimRequestSchema>;
export type PairClaimResponse = z.infer<typeof PairClaimResponseSchema>;
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponseSchema>;
export type AuthLogoutRequest = z.infer<typeof AuthLogoutRequestSchema>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadsResponse = z.infer<typeof ThreadsResponseSchema>;
export type ThreadResponse = z.infer<typeof ThreadResponseSchema>;
export type ThreadResumeResponse = z.infer<typeof ThreadResumeResponseSchema>;
export type ThreadCreateResponse = z.infer<typeof ThreadCreateResponseSchema>;
export type ThreadMessageRequest = z.infer<typeof ThreadMessageRequestSchema>;
export type ThreadMessageResponse = z.infer<typeof ThreadMessageResponseSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type GatewayOptionsResponse = z.infer<typeof GatewayOptionsResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
