// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { IgcValidationJob } from "@bccweb/types";
import * as z from "zod/v4";

export const IgcValidationJobSchema = z
  .object({
    roundId: z.string().min(1),
    teamId: z.string().min(1),
    place: z.number().int(),
    flightId: z.string().min(1),
    validationAttemptId: z.string().min(1),
  })
  .strict() satisfies z.ZodType<IgcValidationJob>;
