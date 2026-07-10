// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEGACY_SIGNATURE_USER_ID,
  assertSeasonYear,
  ensureNonEmpty,
  legacyMigratedSignature,
  parseFrequencyMhz,
} from "../transforms.mjs";

test("legacyMigratedSignature uses the legacy-import user sentinel", () => {
  const signature = legacyMigratedSignature({
    roundId: "round-1",
    teamId: "team-1",
    place: 1,
    pilotId: "pilot-1",
    stableKey: "transforms-test-signature",
  });

  assert.equal(LEGACY_SIGNATURE_USER_ID, "legacy-import");
  assert.equal(signature.userId, "legacy-import");
});

test("parseFrequencyMhz accepts only numeric MHz values in the open interval (0, 1000)", () => {
  assert.equal(parseFrequencyMhz("145.500"), 145.5);
  assert.equal(parseFrequencyMhz(""), undefined);
  assert.equal(parseFrequencyMhz("9999"), undefined);
  assert.equal(parseFrequencyMhz("abc"), undefined);
  assert.equal(parseFrequencyMhz("0"), undefined);
});

test("ensureNonEmpty returns a trimmed non-empty value or fallback", () => {
  assert.equal(ensureNonEmpty("  ", "X"), "X");
  assert.equal(ensureNonEmpty("a", "X"), "a");
  assert.equal(ensureNonEmpty(null, "X"), "X");
});

test("assertSeasonYear coerces valid years and throws on bad source data", () => {
  assert.equal(assertSeasonYear(2026), 2026);
  assert.equal(assertSeasonYear("2026"), 2026);
  assert.throws(() => assertSeasonYear(1899));
  assert.throws(() => assertSeasonYear("x"));
});
