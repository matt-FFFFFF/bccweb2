import type { SeasonClub } from "@bccweb/types";
import * as z from "zod/v4";

export const SeasonClubSchema = z
  .object({
    id: z.string().min(1),
    seasonYear: z.number().int(),
    clubId: z.string().min(1),
    numTeams: z.number().int(),
    acceptedTsCs: z.boolean(),
    acceptedTsCsAt: z.string().min(1).optional(),
    acceptedTsCsBy: z.string().min(1).optional(),
    createdAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
    updatedBy: z.string().min(1).optional(),
    legacyId: z.number().int().optional(),
  })
  .strip();

SeasonClubSchema satisfies z.ZodType<SeasonClub>;
