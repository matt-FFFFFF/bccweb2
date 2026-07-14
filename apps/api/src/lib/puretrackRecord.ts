// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod/v4";

import { getTelemetryClient } from "./telemetry.js";
import { redactObject } from "./telemetryRedactor.js";

const PureTrackRecordSchema = z.looseObject({
  roundId: z.string().min(1),
  externalId: z.string().regex(/^\d+$/),
});

export type PureTrackRecord = z.infer<typeof PureTrackRecordSchema>;

export function parsePureTrackRecord(buffer: Buffer, path: string): PureTrackRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString("utf8"));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    trackMalformedRecord(path);
    return null;
  }

  const parsed = PureTrackRecordSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  trackMalformedRecord(path);
  return null;
}

function trackMalformedRecord(path: string): void {
  getTelemetryClient()?.trackEvent({
    name: "puretrack.malformedGroupRecord",
    properties: redactObject({ path }) as Record<string, unknown>,
  });
}
