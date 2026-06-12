import type { PureTrackGroup } from "@bccweb/types";
import * as z from "zod/v4";

import { healed, healingArray, lenientOptional } from "./helpers.js";

export const PureTrackGroupSchema = z
  .object({
    groupId: z.string().min(1),
    slug: z.string().min(1),
    roundId: z.string().min(1),
    teamId: z.string().min(1),
    name: healed(z.string(), "").default(""),
    pilotIds: healingArray(z.string()).default([]),
    createdAt: healed(z.string(), "").default(""),
    createdBy: lenientOptional(z.string()),
    externalId: lenientOptional(z.string()),
    externalUrl: lenientOptional(z.string()),
    legacyId: lenientOptional(z.number().int()),
  })
  .strip()
  .transform(({ groupId, ...group }) => ({
    id: groupId,
    ...group,
  }));

PureTrackGroupSchema satisfies z.ZodType<PureTrackGroup>;
