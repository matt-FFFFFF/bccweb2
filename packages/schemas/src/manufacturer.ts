import type { Manufacturer } from "@bccweb/types";
import * as z from "zod/v4";

import { lenientOptional } from "./helpers.js";

export const ManufacturerSchema = z
  .object({
    id: z.string().min(1),
    legacyId: lenientOptional(z.number().int()),
    name: z.string().min(1),
    websiteUrl: lenientOptional(z.string()),
  })
  .strip();

ManufacturerSchema satisfies z.ZodType<Manufacturer>;

export const ManufacturersIndexSchema = z.array(ManufacturerSchema);
