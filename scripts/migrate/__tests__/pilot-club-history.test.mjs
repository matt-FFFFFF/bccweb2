import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPilotClubHistory,
  normalizePilotClubRows,
  queryPilotClubRows,
} from "../pilot-club-history-logic.mjs";

function fakePool(queryHandler) {
  return {
    request() {
      return {
        query: queryHandler,
      };
    },
  };
}

async function naivePluralOnlyPilotClubQuery(pool) {
  return (await pool.request().query("SELECT * FROM PilotClubs")).recordset;
}

test("normalizePilotClubRows maps plural PilotClubs rows and defaults missing dates to null", () => {
  const rows = normalizePilotClubRows([
    { ID: 10, PilotID: 20, ClubID: 30 },
  ]);

  assert.deepEqual(rows, [
    { ID: 10, Pilot_ID: 20, Club_ID: 30, JoinedAt: null, LeftAt: null },
  ]);
});

test("normalizePilotClubRows preserves singular PilotClub dates", () => {
  const joinedAt = new Date("2022-01-02T03:04:05.000Z");
  const leftAt = new Date("2023-06-07T08:09:10.000Z");

  const rows = normalizePilotClubRows([
    { ID: 11, Pilot_ID: 21, Club_ID: 31, JoinedAt: joinedAt, LeftAt: leftAt },
  ]);

  assert.deepEqual(rows, [
    { ID: 11, Pilot_ID: 21, Club_ID: 31, JoinedAt: joinedAt, LeftAt: leftAt },
  ]);
});

test("queryPilotClubRows falls back to singular PilotClub when plural table is missing", async () => {
  const queries = [];
  const singularRows = [{ ID: 12, Pilot_ID: 22, Club_ID: 32, JoinedAt: "2021-04-05", LeftAt: null }];
  const pool = fakePool(async (sql) => {
    queries.push(sql);
    if (/PilotClubs/.test(sql)) throw new Error("Invalid object name 'PilotClubs'.");
    if (/PilotClub/.test(sql)) return { recordset: singularRows };
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await assert.rejects(() => naivePluralOnlyPilotClubQuery(pool), /Invalid object name 'PilotClubs'/);

  queries.length = 0;
  await assert.doesNotReject(async () => {
    const rows = await queryPilotClubRows(pool);
    assert.deepEqual(rows, [
      { ID: 12, Pilot_ID: 22, Club_ID: 32, JoinedAt: "2021-04-05", LeftAt: null },
    ]);
  });
  assert.equal(queries.length, 2);
  assert.match(queries[0], /SELECT \* FROM PilotClubs/);
  assert.match(queries[1], /SELECT \* FROM PilotClub/);
});

test("buildPilotClubHistory produces correct history over normalized plural and singular shapes", () => {
  const pilotUuid = new Map([[20, "pilot-a"], [21, "pilot-b"]]);
  const clubUuid = new Map([[30, "club-a"], [31, "club-b"]]);
  const clubsList = [
    { id: "club-a", name: "Avon" },
    { id: "club-b", name: "Bristol" },
  ];
  const rows = normalizePilotClubRows([
    { ID: 10, PilotID: 20, ClubID: 30 },
    { ID: 11, Pilot_ID: 21, Club_ID: 31, JoinedAt: "2022-01-02T03:04:05.000Z", LeftAt: "2023-06-07T08:09:10.000Z" },
  ]);

  const historyByPilot = buildPilotClubHistory(rows, pilotUuid, clubUuid, clubsList, []);

  assert.deepEqual(historyByPilot.get("pilot-a"), [{
    pilotId: "pilot-a",
    clubId: "club-a",
    clubName: "Avon",
    joinedAt: null,
    leftAt: null,
    source: "legacy",
    legacyId: 10,
  }]);
  assert.deepEqual(historyByPilot.get("pilot-b"), [{
    pilotId: "pilot-b",
    clubId: "club-b",
    clubName: "Bristol",
    joinedAt: "2022-01-02T03:04:05.000Z",
    leftAt: "2023-06-07T08:09:10.000Z",
    source: "legacy",
    legacyId: 11,
  }]);
});
