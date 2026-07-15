// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";

import { IgcValidationJobSchema } from "../igcValidationJob.js";

const validJob = {
  roundId: "round-1",
  teamId: "team-1",
  place: 1,
  flightId: "flight-1",
  validationAttemptId: "validation-attempt-1",
} as const;

describe("IgcValidationJobSchema", () => {
  test("accepts a valid IGC validation job", () => {
    expect(IgcValidationJobSchema.parse(validJob)).toEqual(validJob);
  });

  test("rejects an extra queue-message key", () => {
    expect(IgcValidationJobSchema.safeParse({ ...validJob, extra: true }).success).toBe(false);
  });

  test("rejects an empty round id", () => {
    expect(IgcValidationJobSchema.safeParse({ ...validJob, roundId: "" }).success).toBe(false);
  });
});
