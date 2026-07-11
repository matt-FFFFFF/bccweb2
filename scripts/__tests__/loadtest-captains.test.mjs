// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { runCaptainPhase } from "../lib/loadTestCaptains.mjs";
import { buildLoadTestManifest } from "../lib/loadTestTopology.mjs";
import { main as runCaptainScript } from "../set-captains-loadtest.mjs";

const YEAR = 2026;
const ROUND_ID = "round-loadtest";

function fixture() {
  const manifest = buildLoadTestManifest({ seasonYear: YEAR, siteNames: ["Load Site"] });
  const roundTeamIdByCanonical = new Map(
    manifest.teams.map((team, index) => [team.id, `round-team-${index + 1}`]),
  );
  const prepared = {
    roundId: ROUND_ID,
    seasonYear: YEAR,
    siteId: manifest.siteIds[0],
    teams: manifest.pilots.map((pilot) => ({
      teamId: roundTeamIdByCanonical.get(pilot.clubTeamId),
      place: pilot.teamLocalRank + 1,
      pilotEmail: pilot.email,
      pilotPassword: "loadtest-pw-bcc",
      pilotId: pilot.id,
    })),
    baseUrl: "http://127.0.0.1:7172",
    isAzureTarget: false,
  };
  const round = {
    id: ROUND_ID,
    status: "Confirmed",
    teams: manifest.teams.map((team) => {
      const teamPilots = manifest.pilots.filter((pilot) => pilot.clubTeamId === team.id);
      return {
        id: roundTeamIdByCanonical.get(team.id),
        teamName: team.teamName,
        club: { id: team.clubId, name: team.clubName },
        captainPilotId: null,
        pilots: teamPilots.map((pilot) => ({
          status: "Filled",
          pilotId: pilot.id,
          placeInTeam: 10 - pilot.teamLocalRank,
        })),
      };
    }),
  };
  return { manifest, prepared, round };
}

function fakeApi(round, options = {}) {
  const calls = [];
  let putCount = 0;
  const callApi = async (method, path, request = {}) => {
    calls.push({ method, path, request });
    if (path === "/api/auth/login") {
      return { accessToken: `access:${request.body.email}`, refreshToken: "must-not-persist" };
    }
    if (method === "GET") return structuredClone(round);
    putCount += 1;
    if (putCount === options.failPutAt) throw new Error("injected captain PUT failure");
    const teamId = path.split("/").at(-2);
    const team = round.teams.find((candidate) => candidate.id === teamId);
    assert.ok(team);
    const coordinatorEmail = request.token.slice("access:".length);
    const coordinatorClubId = options.manifest.coordinators.find(
      (coordinator) => coordinator.email === coordinatorEmail,
    )?.clubId;
    assert.equal(coordinatorClubId, team.club.id, "captain PUT must use own-club coordinator");
    team.captainPilotId = request.body.pilotId;
    return options.wrongPutResponse ? { ...team, captainPilotId: "wrong-pilot" } : structuredClone(team);
  };
  return { callApi, calls, putCount: () => putCount };
}

async function run(fx, apiOptions = {}) {
  const writes = [];
  const api = fakeApi(fx.round, { ...apiOptions, manifest: fx.manifest });
  const result = await runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: api.callApi,
    writePrepared: async (value) => writes.push(value),
  });
  return { ...api, writes, result };
}

test("reconciles authoritative places and assigns rank-zero captains with 25 reused logins", async () => {
  // Given
  const fx = fixture();

  // When
  const observed = await run(fx);

  // Then
  assert.equal(observed.calls.filter((call) => call.path === "/api/auth/login").length, 25);
  assert.equal(new Set(observed.calls.filter((call) => call.path === "/api/auth/login").map(
    (call) => call.request.body.email,
  )).size, 25);
  assert.equal(observed.putCount(), 50);
  assert.equal(observed.calls.filter((call) => call.method === "GET").length, 2);
  assert.equal(observed.writes.length, 1);
  assert.deepEqual(observed.result, { coordinators: 25, captains: 50, slots: 500 });
  assert.equal(observed.writes[0].teams[0].place, 10);
  assert.equal(observed.writes[0].teams[9].place, 1);
  assert.doesNotMatch(JSON.stringify(observed.writes[0]), /access:|refreshToken|accessToken/);
  for (const [teamIndex, team] of fx.round.teams.entries()) {
    assert.equal(team.captainPilotId, fx.manifest.pilots[teamIndex * 10].id);
  }
});

test("rejects malformed prepared pilot metadata before login or mutation", async () => {
  // Given
  const fx = fixture();
  fx.prepared.teams[0].pilotId = "";
  const api = fakeApi(fx.round, { manifest: fx.manifest });

  // When / Then
  await assert.rejects(runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: api.callApi,
    writePrepared: async () => assert.fail("must not rewrite"),
  }), /prepared.*pilot/i);
  assert.equal(api.calls.length, 0);
});

test("rejects prepared team ownership mismatch before login or mutation", async () => {
  // Given
  const fx = fixture();
  fx.prepared.teams[10].teamId = fx.prepared.teams[0].teamId;
  const api = fakeApi(fx.round, { manifest: fx.manifest });

  // When / Then
  await assert.rejects(runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: api.callApi,
    writePrepared: async () => assert.fail("must not rewrite"),
  }), /team.*ownership|canonical team/i);
  assert.equal(api.calls.length, 0);
});

test("rejects wrong coordinator club before login or mutation", async () => {
  // Given
  const fx = fixture();
  fx.manifest.coordinators[0].clubId = fx.manifest.clubs[1].id;
  const api = fakeApi(fx.round, { manifest: fx.manifest });

  // When / Then
  await assert.rejects(runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: api.callApi,
    writePrepared: async () => assert.fail("must not rewrite"),
  }), /COORDINATOR_MISMATCH/);
  assert.equal(api.calls.length, 0);
});

for (const corruption of ["missing pilot", "duplicate place", "wrong club"]) {
  test(`rejects authoritative ${corruption} before captain PUT`, async () => {
    // Given
    const fx = fixture();
    if (corruption === "missing pilot") fx.round.teams[0].pilots.pop();
    if (corruption === "duplicate place") fx.round.teams[0].pilots[1].placeInTeam = 10;
    if (corruption === "wrong club") fx.round.teams[0].club.id = fx.manifest.clubs[1].id;
    const api = fakeApi(fx.round, { manifest: fx.manifest });

    // When / Then
    await assert.rejects(runCaptainPhase({
      manifest: fx.manifest,
      prepared: fx.prepared,
      expectedSeasonYear: YEAR,
      callApi: api.callApi,
      writePrepared: async () => assert.fail("must not rewrite"),
    }), /authoritative|club|place|pilot/i);
    assert.equal(api.putCount(), 0);
  });
}

test("does not rewrite after a non-200 captain PUT", async () => {
  // Given
  const fx = fixture();
  const writes = [];
  const api = fakeApi(fx.round, { manifest: fx.manifest, failPutAt: 17 });

  // When / Then
  await assert.rejects(runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: api.callApi,
    writePrepared: async (value) => writes.push(value),
  }), /injected captain PUT failure/);
  assert.equal(api.putCount(), 17);
  assert.equal(writes.length, 0);
});

test("rerun after partial captain assignment converges and rewrites once", async () => {
  // Given
  const fx = fixture();
  const interrupted = fakeApi(fx.round, { manifest: fx.manifest, failPutAt: 17 });
  await assert.rejects(runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: interrupted.callApi,
    writePrepared: async () => assert.fail("interrupted run must not rewrite"),
  }));

  // When
  const rerun = await run(fx);

  // Then
  assert.equal(rerun.putCount(), 50);
  assert.equal(rerun.writes.length, 1);
  assert.deepEqual(rerun.result, { coordinators: 25, captains: 50, slots: 500 });
});

test("rejects wrong captain in PUT response without rewriting", async () => {
  // Given
  const fx = fixture();
  const writes = [];
  const api = fakeApi(fx.round, { manifest: fx.manifest, wrongPutResponse: true });

  // When / Then
  await assert.rejects(runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: api.callApi,
    writePrepared: async (value) => writes.push(value),
  }), /captain.*response/i);
  assert.equal(writes.length, 0);
});

test("rejects wrong final captain without rewriting", async () => {
  // Given
  const fx = fixture();
  const writes = [];
  const api = fakeApi(fx.round, { manifest: fx.manifest });
  const originalCall = api.callApi;
  let getCount = 0;
  api.callApi = async (...args) => {
    const response = await originalCall(...args);
    if (args[0] === "GET" && ++getCount === 2) response.teams[0].captainPilotId = "wrong-final";
    return response;
  };

  // When / Then
  await assert.rejects(runCaptainPhase({
    manifest: fx.manifest,
    prepared: fx.prepared,
    expectedSeasonYear: YEAR,
    callApi: api.callApi,
    writePrepared: async (value) => writes.push(value),
  }), /final.*captain/i);
  assert.equal(api.putCount(), 50);
  assert.equal(writes.length, 0);
});

test("script atomically replaces prepared metadata with mode 0600 and no tokens", async (t) => {
  // Given
  const fx = fixture();
  const directory = await mkdtemp(join(tmpdir(), "bcc-loadtest-captains-"));
  t.after(() => rm(directory, { recursive: true }));
  const manifestPath = join(directory, "manifest.json");
  const preparedPath = join(directory, "prepared.json");
  await writeFile(manifestPath, JSON.stringify(fx.manifest));
  await writeFile(preparedPath, JSON.stringify(fx.prepared), { mode: 0o644 });
  const api = fakeApi(fx.round, { manifest: fx.manifest });

  // When
  await runCaptainScript({
    manifestPath,
    preparedPath,
    baseUrl: fx.prepared.baseUrl,
    expectedSeasonYear: YEAR,
    createApi: () => api.callApi,
    log: () => {},
  });

  // Then
  const contents = await readFile(preparedPath, "utf8");
  assert.equal((await stat(preparedPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(contents, /access:|refreshToken|accessToken/);
  assert.equal(JSON.parse(contents).teams[0].place, 10);
});
