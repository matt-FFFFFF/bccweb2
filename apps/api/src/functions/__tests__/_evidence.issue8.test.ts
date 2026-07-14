// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueuePureTrackGroupJob: vi.fn(),
}));

import "../admin.js";
import "../adminWording.js";
import "../brief.js";
import "../clubTeams.js";
import "../clubs.js";
import "../flights.js";
import "../pilots.js";
import "../pilotSeasonClubs.js";
import "../puretrack.js";
import "../roundsMutate.js";
import "../seasonClubs.js";
import "../seasons.js";
import "../sites.js";
import "../teams.js";
import "../teamsCaptain.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import { ADMIN_CASES } from "./issue8EvidenceAdminCases.js";
import { COARSE_SELF_CASES } from "./issue8EvidenceCoarseCases.js";
import {
  invokeEvidenceHandler,
  makeEvidenceRequest,
  retryAfter,
  saturateOwnBucket,
  sourceMutationCallSites,
} from "./issue8EvidenceHarness.js";
import { SCOPED_CASES } from "./issue8EvidenceScopedCases.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const FUNCTIONS_DIRECTORY = path.resolve(HERE, "..");
const CASES = [...ADMIN_CASES, ...SCOPED_CASES, ...COARSE_SELF_CASES];

function sortKey(row: {
  readonly file: string;
  readonly endpoint: string;
  readonly tier: string;
}): string {
  return `${row.file}:${row.endpoint}:${row.tier}`;
}

describe("Issue 8 mutationRateLimit ordering evidence", () => {
  it("enumerates every source mutationRateLimit call site", async () => {
    const sourceRows = await sourceMutationCallSites(FUNCTIONS_DIRECTORY);
    const enumeratedRows = CASES.map(({ file, endpoint, tier }) => ({
      file,
      endpoint,
      tier,
    }));
    expect(enumeratedRows).toHaveLength(sourceRows.length);
    expect(enumeratedRows.map(sortKey).sort()).toEqual(
      sourceRows.map(sortKey).sort()
    );
  });

  for (const row of CASES) {
    it(`${row.file} ${row.handler} (${row.endpoint}/${row.tier}) returns 403 before saturated same-endpoint 429`, async () => {
      const context = await row.setup();
      resetAllBuckets();
      await saturateOwnBucket(row, context);
      const response = await invokeEvidenceHandler(
        row.handler,
        makeEvidenceRequest(context.forbidden, context.request)
      );
      expect(response.status).toBe(403);
      expect(response.status).not.toBe(429);
      expect((response.jsonBody as { code?: string } | undefined)?.code).toBe(
        "FORBIDDEN"
      );
      expect(retryAfter(response)).toBeUndefined();
    });
  }
});

export const issue8MutationRateLimitEvidence = {
  cases: CASES,
  repoRoot: REPO_ROOT,
};
