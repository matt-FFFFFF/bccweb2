// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { ActiveWordingPointerSchema, SignToFlyWordingSchema } from "@bccweb/schemas";

export const WORDING_PATH = "sign-to-fly/wording/1.json";
export const ACTIVE_WORDING_PATH = "sign-to-fly/wording/active.json";

export const SIGN_TO_FLY_MARKDOWN = `By clicking **Sign to Fly**, you are confirming that you have received and understood a full brief for this round, which incorporated:

The day's expected meteorological conditions, including anticipated convection activity, convergence lines, cloud cover, and any frontal effects (including sea breeze fronts).

An understanding of any conditions which would require terminating the flight for safety reasons, made with reference to a current aeronautical chart, details of all controlled airspace or hazards to aviation that may be encountered along the anticipated route of the flight (including NOTAMs), up to a clearly defined "May not exceed" limit.

That you have received and understood a suitable briefing, made with reference to a current aeronautical chart, which addresses all controlled airspace or hazards to aviation that may be encountered along the anticipated route of the flight (including NOTAM's), up to the "Do not exceed" limit detailed in this briefing document.

> **Club Pilots**
>
> You are confirming that you are aware of the geographical limits and altitude, height or flight level limits of the airspace or hazards and that you are confident of your ability to navigate and safely avoid any such areas or hazards.
>
> In addition you are confirming that you understand that if the flight should stray outside the anticipated "cone" of the briefed track, or reach the "May not exceed" limit, your flight must be discontinued.

Are you sure you want to **Sign to Fly** in this round?
`;

export function buildCanonicalSignToFlyWording(createdAt) {
  return SignToFlyWordingSchema.parse({
    version: 1,
    hash: createHash("sha256").update(SIGN_TO_FLY_MARKDOWN, "utf8").digest("hex"),
    markdown: SIGN_TO_FLY_MARKDOWN,
    createdAt,
    createdBy: "seed-script",
  });
}

export function activeWordingPointer() {
  return ActiveWordingPointerSchema.parse({ activeVersion: 1 });
}
