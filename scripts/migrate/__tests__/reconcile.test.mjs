import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECONCILE_SCRIPT = resolve(__dirname, "..", "reconcile.mjs");

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "bcc-reconcile-"));
  mkdirSync(join(dir, ".migration-state"), { recursive: true });
  return dir;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function runReconcile(cwd, args = [], env = {}) {
  return spawnSync("node", [RECONCILE_SCRIPT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("reconcile.mjs", () => {
  test("--against-prod-snapshot produces expected JSON shape", () => {
    const cwd = makeWorkspace();
    writeJson(join(cwd, ".migration-state", "id-map.json"), {
      "club:1": "club-uuid-1",
      "club:2": "club-uuid-2",
      "pilot:10": "pilot-uuid-10",
    });
    writeFileSync(
      join(cwd, ".migration-state", "prod-dryrun-stdout.txt"),
      "  wrote 2 clubs\n  wrote 1 pilots\n",
      "utf8",
    );
    const snapshotPath = join(cwd, ".migration-state", "snapshot.json");
    writeJson(snapshotPath, { expectedCounts: { club: 2, pilot: 1 } });

    const result = runReconcile(cwd, ["--against-prod-snapshot", snapshotPath], {
      PROD_SQL_CONN: "Server=tcp:bcc-prod;User Id=sa;Password=secret;",
      PROD_BLOB_CONN: "DefaultEndpointsProtocol=https;AccountName=p;AccountKey=secret;",
    });

    expect(result.status).toBe(0);
    const reportPath = join(cwd, ".migration-state", "prod-dryrun-report.json");
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toMatchObject({
      source: {
        sqlConn: "Server=tcp:bcc-prod;User Id=sa;Password=***;",
        blobConn: "DefaultEndpointsProtocol=https;AccountName=p;AccountKey=***;",
      },
      perEntity: {
        club: { count: 2, sample: ["club-uuid-1", "club-uuid-2"] },
        pilot: { count: 1, sample: ["pilot-uuid-10"] },
      },
      discarded: {},
      anomalies: [],
    });
    expect(typeof report.generatedAt).toBe("string");
    expect(report.prodRows.club).toMatchObject({
      entity: "club",
      expectedCount: 2,
      actualCount: 2,
      idMapStable: true,
      anomalies: [],
    });
  });

  test("detects count mismatch as anomaly", () => {
    const cwd = makeWorkspace();
    writeJson(join(cwd, ".migration-state", "id-map.json"), {
      "club:1": "club-uuid-1",
    });
    const snapshotPath = join(cwd, ".migration-state", "snapshot.json");
    writeJson(snapshotPath, { expectedCounts: { club: 2 } });

    const result = runReconcile(cwd, ["--against-prod-snapshot", snapshotPath]);

    expect(result.status).toBe(1);
    const report = JSON.parse(
      readFileSync(join(cwd, ".migration-state", "prod-dryrun-report.json"), "utf8"),
    );
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({
        type: "count_mismatch",
        entity: "club",
        message: "club: expected 2, got 1",
      }),
    );
  });

  test("--discarded-counts integration (T32)", () => {
    const cwd = makeWorkspace();
    writeJson(join(cwd, ".migration-state", "id-map.json"), {
      "round:1": "round-uuid-1",
    });
    writeJson(join(cwd, ".migration-state", "discarded-counts.json"), {
      roundClubPilot: 2,
    });

    const result = runReconcile(cwd);

    expect(result.status).toBe(0);
    const report = JSON.parse(
      readFileSync(join(cwd, ".migration-state", "reconciliation-report.json"), "utf8"),
    );
    expect(report.discarded.roundClubPilot).toBe(2);
    expect(result.stdout).toContain("roundClubPilot: 2 rows");
  });
});
