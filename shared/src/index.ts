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
  cwd: z.string().optional(),
  inProgress: z.boolean().optional(),
});

export const ThreadsResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema),
});

export const WorkspacesResponseSchema = z.object({
  workspaces: z.array(z.string().min(1)),
  defaultCwd: z.string().min(1).optional(),
});

export const DirectoryEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export const DirectoryBrowseResponseSchema = z.object({
  currentPath: z.string().min(1),
  parentPath: z.string().min(1).nullable(),
  folders: z.array(DirectoryEntrySchema),
});

export const ThreadFilesQuerySchema = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const ThreadFilesResponseSchema = z.object({
  cwd: z.string().min(1),
  files: z.array(z.string().min(1)),
});

export const ThreadResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  title: z.string().optional(),
  turns: z.array(z.unknown()),
});

export const ThreadEventSchema = z.object({
  id: z.number().int().positive(),
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  method: z.string().min(1),
  params: z.unknown(),
  createdAt: z.string().datetime(),
});

export const ThreadEventsResponseSchema = z.object({
  events: z.array(ThreadEventSchema),
});

export const ThreadResumeResponseSchema = z.object({
  ok: z.literal(true),
});

export const ThreadCreateResponseSchema = z.object({
  ok: z.literal(true),
  threadId: z.string().min(1),
});

export const ThreadCreateRequestSchema = z.object({
  cwd: z.string().min(1).optional(),
});

export const ThreadNameSetRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const ThreadNameSetResponseSchema = z.object({
  ok: z.literal(true),
  threadId: z.string().min(1),
  name: z.string().min(1),
});

export const ThreadMessageRequestSchema = z.object({
  text: z.string().optional(),
  images: z
    .array(
      z.object({
        imageUrl: z.string().min(1),
      })
    )
    .optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
}).superRefine((value, ctx) => {
  const hasText = typeof value.text === "string" && value.text.trim().length > 0;
  const hasImages = Array.isArray(value.images) && value.images.length > 0;
  if (!hasText && !hasImages) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either text or images must be provided.",
      path: ["text"],
    });
  }
});

export const ThreadMessageResponseSchema = z.object({
  ok: z.literal(true),
  turnId: z.string().optional(),
});

export const ThreadInterruptRequestSchema = z.object({
  turnId: z.string().min(1).optional(),
});

export const ThreadInterruptResponseSchema = z.object({
  ok: z.literal(true),
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

export const PairedDeviceSchema = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});

export const PairedDevicesResponseSchema = z.object({
  devices: z.array(PairedDeviceSchema),
});

export type PairCreateResponse = z.infer<typeof PairCreateResponseSchema>;
export type PairClaimRequest = z.infer<typeof PairClaimRequestSchema>;
export type PairClaimResponse = z.infer<typeof PairClaimResponseSchema>;
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponseSchema>;
export type AuthLogoutRequest = z.infer<typeof AuthLogoutRequestSchema>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadsResponse = z.infer<typeof ThreadsResponseSchema>;
export type WorkspacesResponse = z.infer<typeof WorkspacesResponseSchema>;
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;
export type DirectoryBrowseResponse = z.infer<typeof DirectoryBrowseResponseSchema>;
export type ThreadFilesQuery = z.infer<typeof ThreadFilesQuerySchema>;
export type ThreadFilesResponse = z.infer<typeof ThreadFilesResponseSchema>;
export type ThreadResponse = z.infer<typeof ThreadResponseSchema>;
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;
export type ThreadEventsResponse = z.infer<typeof ThreadEventsResponseSchema>;
export type ThreadResumeResponse = z.infer<typeof ThreadResumeResponseSchema>;
export type ThreadCreateResponse = z.infer<typeof ThreadCreateResponseSchema>;
export type ThreadCreateRequest = z.infer<typeof ThreadCreateRequestSchema>;
export type ThreadNameSetRequest = z.infer<typeof ThreadNameSetRequestSchema>;
export type ThreadNameSetResponse = z.infer<typeof ThreadNameSetResponseSchema>;
export type ThreadMessageRequest = z.infer<typeof ThreadMessageRequestSchema>;
export type ThreadMessageResponse = z.infer<typeof ThreadMessageResponseSchema>;
export type ThreadInterruptRequest = z.infer<typeof ThreadInterruptRequestSchema>;
export type ThreadInterruptResponse = z.infer<typeof ThreadInterruptResponseSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type GatewayOptionsResponse = z.infer<typeof GatewayOptionsResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;
export type PairedDevicesResponse = z.infer<typeof PairedDevicesResponseSchema>;
