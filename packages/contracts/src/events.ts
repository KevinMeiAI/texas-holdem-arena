import { z } from "zod";

export const privateVisibilitySchema = z.enum([
  "NONE",
  "PLAYER_HOLE_CARDS",
  "ADMIN_AUDIT",
]);

export type PrivateVisibility = z.infer<typeof privateVisibilitySchema>;

export const encryptedPayloadSchema = z.object({
  algorithm: z.literal("aes-256-gcm"),
  nonce: z.string().min(1),
  ciphertext: z.string(),
  authTag: z.string().min(1),
}).strict();

export type EncryptedPayload = z.infer<typeof encryptedPayloadSchema>;

export const newArenaEventSchema = z.object({
  type: z.string().min(1).max(120),
  actorId: z.string().min(1).max(200).nullable().default(null),
  handNo: z.number().int().positive().nullable().default(null),
  publicPayload: z.unknown(),
  privatePayload: z.unknown().optional(),
  privateVisibility: privateVisibilitySchema.default("NONE"),
  privateOwnerId: z.string().min(1).max(200).nullable().default(null),
}).strict().superRefine((event, context) => {
  if (event.privateVisibility === "PLAYER_HOLE_CARDS" && (!event.privateOwnerId || !event.handNo)) {
    context.addIssue({
      code: "custom",
      message: "PLAYER_HOLE_CARDS requires privateOwnerId and handNo",
    });
  }
  if (event.privateVisibility === "NONE" && event.privatePayload !== undefined) {
    context.addIssue({ code: "custom", message: "Private payload requires a visibility policy" });
  }
  if (event.privateVisibility !== "NONE" && event.privatePayload === undefined) {
    context.addIssue({ code: "custom", message: "Private visibility requires a private payload" });
  }
});

export type NewArenaEvent = z.infer<typeof newArenaEventSchema>;

export const storedArenaEventSchema = z.object({
  tournamentId: z.string().uuid(),
  sequence: z.number().int().positive(),
  aggregateVersion: z.number().int().positive(),
  type: z.string().min(1).max(120),
  actorId: z.string().nullable(),
  handNo: z.number().int().positive().nullable(),
  publicPayload: z.unknown(),
  encryptedPrivatePayload: encryptedPayloadSchema.nullable(),
  privateVisibility: privateVisibilitySchema,
  privateOwnerId: z.string().nullable(),
  prevHash: z.string().regex(/^[a-f0-9]{64}$/),
  eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
}).strict();

export type StoredArenaEvent = z.infer<typeof storedArenaEventSchema>;

export interface LoadedArenaEvent {
  event: StoredArenaEvent;
  privatePayload?: unknown;
}
