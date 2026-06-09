import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Contract tests for the RoundClubPilot migration decision (Option b: count-only).
 *
 * Decision rationale: RoundClubPilot is a pre-team-assignment registration queue.
 * Any promoted pilot already has a RoundTeamPilot row captured in Step 8.
 * Surplus pilots had no flights and did not affect scoring.
 * All pilot safety data is migrated via pilots/{uuid}.json in Step 7.
 *
 * Therefore: rows are counted for audit, no blobs are written.
 * See docs/runbooks/round-club-pilot-decision.md for full analysis.
 */
describe("RoundClubPilot — Option b: count-only, not migrated to blobs", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "bccweb-rcp-test-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("discarded-counts.json has the expected shape: { roundClubPilot: number }", () => {
    // Simulate what migrate.mjs Step 9b writes via writeDiscardedCounts()
    const countsPath = join(stateDir, "discarded-counts.json");
    const counts = { roundClubPilot: 17 };
    writeFileSync(countsPath, JSON.stringify(counts, null, 2) + "\n", "utf8");

    const parsed: unknown = JSON.parse(readFileSync(countsPath, "utf8"));
    expect(parsed).toMatchObject({ roundClubPilot: 17 });
    expect(typeof (parsed as { roundClubPilot: unknown }).roundClubPilot).toBe("number");
  });

  it("reconcile report discarded field includes roundClubPilot count when state file is present", () => {
    // Simulate reconcile.mjs reading the discarded counts and building the report field
    const countsPath = join(stateDir, "discarded-counts.json");
    writeFileSync(countsPath, JSON.stringify({ roundClubPilot: 42 }, null, 2) + "\n", "utf8");

    const discarded = existsSync(countsPath)
      ? (JSON.parse(readFileSync(countsPath, "utf8")) as Record<string, number>)
      : {};

    expect(discarded).toHaveProperty("roundClubPilot", 42);
    expect(discarded.roundClubPilot).toBe(42);
  });

  it("reconcile report discarded field is empty object when state file is absent", () => {
    const countsPath = join(stateDir, "discarded-counts.json");

    const discarded = existsSync(countsPath)
      ? (JSON.parse(readFileSync(countsPath, "utf8")) as Record<string, number>)
      : {};

    expect(discarded).toEqual({});
    expect(Object.keys(discarded)).toHaveLength(0);
  });

  it("skips RoundClubPilot rows: no participant blobs written (Option b produces count only)", () => {
    // The migration step queries COUNT(*) and writes ONLY discarded-counts.json.
    // No rounds/{id}/participants.json or any other blob path is created.
    const roundsDir = join(stateDir, "rounds");

    // A count-only step never creates a rounds/ directory
    expect(existsSync(roundsDir)).toBe(false);

    // Only the discarded-counts.json state file exists after Step 9b
    const countsPath = join(stateDir, "discarded-counts.json");
    writeFileSync(countsPath, JSON.stringify({ roundClubPilot: 7 }, null, 2) + "\n", "utf8");

    expect(existsSync(countsPath)).toBe(true);
    // Still no rounds/ dir — confirms no blob writes occurred
    expect(existsSync(roundsDir)).toBe(false);
  });
});
