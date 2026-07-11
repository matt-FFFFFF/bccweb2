// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildLoadTestManifest } from "../lib/loadTestTopology.mjs";

const prepareScript = resolve("scripts/prepare-loadtest.mjs");
const seedScript = resolve("scripts/seed-rounds.mjs");
const FIXED_NOW = "2026-07-11T12:00:00.000Z";

async function fixtureDir(t, manifest) {
  const cwd = await mkdtemp(join(tmpdir(), "bcc-load-rounds-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "tests/load"), { recursive: true });
  await writeFile(join(cwd, ".fixture-manifest.json"), JSON.stringify(manifest));
  return cwd;
}

function runPrepare(cwd, hookPath) {
  return spawnSync(process.execPath, ["--import", hookPath, prepareScript], {
    cwd,
    env: { ...process.env, ADMIN_PASSWORD: "test-password" },
    encoding: "utf8",
  });
}

function runScript(script, cwd, hookPath) {
  return spawnSync(process.execPath, ["--import", hookPath, script], {
    cwd,
    env: { ...process.env, ADMIN_PASSWORD: "test-password" },
    encoding: "utf8",
  });
}

function fixedDateHook() {
  return `const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length === 0 ? [${JSON.stringify(FIXED_NOW)}] : args)); }
  static now() { return new RealDate(${JSON.stringify(FIXED_NOW)}).getTime(); }
};
`;
}

test("prepare creates the canonical 25-club topology at plus 35 days", async (t) => {
  // Given
  const manifest = buildLoadTestManifest({ seasonYear: 2026, siteNames: ["Site Alpha"] });
  const cwd = await fixtureDir(t, manifest);
  const callsPath = join(cwd, "calls.jsonl");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { appendFileSync } from "node:fs";
${fixedDateHook()}
let team = 0;
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ url: String(url), method: init.method, body }) + "\\n");
  if (String(url).endsWith("/api/auth/login")) return Response.json({ accessToken: "admin-token" });
  if (String(url).endsWith("/api/rounds")) return Response.json({ id: "round-current" }, { status: 201 });
  if (String(url).endsWith("/teams")) {
    team += 1;
    return Response.json({ teams: Array.from({ length: team }, (_, index) => ({ id: "team-" + index, teamName: ${JSON.stringify(manifest.teams)}[index].teamName, club: { id: ${JSON.stringify(manifest.teams)}[index].clubId } })) });
  }
  return Response.json({ status: "Confirmed" });
};
`,
  );

  // When
  const result = runPrepare(cwd, hookPath);

  // Then
  assert.equal(result.status, 0, result.stderr);
  const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const create = calls.find((call) => call.url.endsWith("/api/rounds"));
  const teams = calls.filter((call) => call.url.endsWith("/teams"));
  assert.equal(create.body.organisingClubId, manifest.clubIds[0]);
  assert.equal(create.body.date, "2026-08-15");
  assert.equal(teams.length, 50);
  assert.deepEqual(
    teams.map(({ body }) => body),
    manifest.teams.map(({ clubId, teamName }) => ({ clubId, teamName })),
  );
});

test("prepare rejects a count-only manifest before any HTTP request", async (t) => {
  // Given
  const canonical = buildLoadTestManifest({ seasonYear: 2026, siteNames: ["Site Alpha"] });
  const staleManifest = {
    seasonYear: canonical.seasonYear,
    siteIds: canonical.siteIds,
    clubIds: Array.from({ length: 50 }, (_, index) => `stale-club-${index}`),
    pilotIds: canonical.pilotIds,
  };
  const cwd = await fixtureDir(t, staleManifest);
  const callsPath = join(cwd, "calls.txt");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { appendFileSync } from "node:fs";
${fixedDateHook()}
globalThis.fetch = async () => {
  appendFileSync(${JSON.stringify(callsPath)}, "called\\n");
  return new Response("unexpected", { status: 500 });
};
`,
  );

  // When
  const result = runPrepare(cwd, hookPath);

  // Then
  assert.equal(result.status, 1);
  await assert.rejects(readFile(callsPath, "utf8"), { code: "ENOENT" });
});

test("prepare rejects malformed checkpoint state before any HTTP request", async (t) => {
  // Given
  const manifest = buildLoadTestManifest({ seasonYear: 2026, siteNames: ["Site Alpha"] });
  const cwd = await fixtureDir(t, manifest);
  await writeFile(join(cwd, ".loadtest-round-state.json"), JSON.stringify({
    version: 1,
    seedRoundIds: [],
    loadRoundId: null,
    unexpected: true,
  }));
  const callsPath = join(cwd, "calls.txt");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { appendFileSync } from "node:fs";
${fixedDateHook()}
globalThis.fetch = async () => {
  appendFileSync(${JSON.stringify(callsPath)}, "called\\n");
  return new Response("unexpected", { status: 500 });
};
`,
  );

  // When
  const result = runPrepare(cwd, hookPath);

  // Then
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected keys/);
  await assert.rejects(readFile(callsPath, "utf8"), { code: "ENOENT" });
});

test("prepare checkpoints a created round before the first team failure", async (t) => {
  // Given
  const manifest = buildLoadTestManifest({ seasonYear: 2026, siteNames: ["Site Alpha"] });
  const cwd = await fixtureDir(t, manifest);
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `${fixedDateHook()}
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/auth/login")) return Response.json({ accessToken: "admin-token" });
  if (String(url).endsWith("/api/rounds")) return Response.json({ id: "round-orphan" }, { status: 201 });
  return new Response("injected add-team failure", { status: 500 });
};
`,
  );

  // When
  const result = runPrepare(cwd, hookPath);

  // Then
  assert.equal(result.status, 1);
  const checkpoint = JSON.parse(await readFile(join(cwd, ".loadtest-round-state.json"), "utf8"));
  assert.equal(checkpoint.loadRoundId, "round-orphan");
});

test("seed rounds uses canonical Team A and real pilot self-registration", async (t) => {
  // Given
  const manifest = buildLoadTestManifest({ seasonYear: 2026, siteNames: ["Site Alpha"] });
  const cwd = await fixtureDir(t, manifest);
  const callsPath = join(cwd, "calls.jsonl");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { appendFileSync } from "node:fs";
${fixedDateHook()}
let round = 0;
const teams = new Map();
globalThis.fetch = async (url, init = {}) => {
  const textUrl = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ url: textUrl, method: init.method, body }) + "\\n");
  if (textUrl.endsWith("/api/auth/login")) return Response.json({ accessToken: "token" });
  if (textUrl.endsWith("/api/rounds")) {
    round += 1;
    teams.set("round-" + round, []);
    return Response.json({ id: "round-" + round }, { status: 201 });
  }
  if (textUrl.endsWith("/teams")) {
    const roundId = textUrl.match(/rounds\\/(round-\\d+)/)?.[1];
    const roundTeams = teams.get(roundId);
    roundTeams.push({ id: roundId + "-team-" + roundTeams.length, teamName: body.teamName, club: { id: body.clubId } });
    return Response.json({ teams: roundTeams });
  }
  return Response.json({ status: "ok" });
};
`,
  );

  // When
  const result = runScript(seedScript, cwd, hookPath);

  // Then
  assert.equal(result.status, 0, result.stderr);
  const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const addedTeams = calls.filter((call) => call.url.endsWith("/teams"));
  const registrations = calls.filter((call) => call.url.endsWith("/register-self"));
  assert.equal(addedTeams.length, 16);
  assert.ok(addedTeams.every((call) => call.body.teamName.endsWith("Team A")));
  assert.equal(registrations.length, 48);
  const creates = calls.filter((call) => call.url.endsWith("/api/rounds"));
  assert.deepEqual(creates.map((call) => call.body.date), [
    "2026-07-18",
    "2026-07-25",
    "2026-08-01",
    "2026-08-08",
  ]);
  const pilotLogs = result.stderr
    .split("\n")
    .filter((line) => line.includes("authenticated synthetic pilot"));
  assert.equal(pilotLogs.length, 12);
});

test("seed checkpoints the created ID in state and manifest before team mutation", async (t) => {
  // Given
  const manifest = buildLoadTestManifest({ seasonYear: 2026, siteNames: ["Site Alpha"] });
  const cwd = await fixtureDir(t, manifest);
  await writeFile(join(cwd, ".loadtest-round-state.json"), JSON.stringify({
    version: 1,
    seedRoundIds: [],
    loadRoundId: "load-preserved",
  }));
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `${fixedDateHook()}
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/auth/login")) return Response.json({ accessToken: "token" });
  if (String(url).endsWith("/api/rounds")) return Response.json({ id: "seed-orphan" }, { status: 201 });
  return new Response("injected team failure", { status: 500 });
};
`,
  );

  // When
  const result = runScript(seedScript, cwd, hookPath);

  // Then
  assert.equal(result.status, 1);
  const checkpoint = JSON.parse(await readFile(join(cwd, ".loadtest-round-state.json"), "utf8"));
  const persistedManifest = JSON.parse(await readFile(join(cwd, ".fixture-manifest.json"), "utf8"));
  assert.deepEqual(checkpoint.seedRoundIds, ["seed-orphan"]);
  assert.equal(checkpoint.loadRoundId, "load-preserved");
  assert.deepEqual(persistedManifest.roundIds, ["seed-orphan"]);
});
