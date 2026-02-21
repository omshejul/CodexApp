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
  title: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const ThreadsResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema),
});

export const ThreadResponseSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  turns: z.array(z.unknown()),
});

export const ThreadResumeResponseSchema = z.object({
  ok: z.literal(true),
});

export const ThreadMessageRequestSchema = z.object({
  text: z.string().min(1),
});

export const ThreadMessageResponseSchema = z.object({
  ok: z.literal(true),
  turnId: z.string().optional(),
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
export type ThreadMessageRequest = z.infer<typeof ThreadMessageRequestSchema>;
export type ThreadMessageResponse = z.infer<typeof ThreadMessageResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
