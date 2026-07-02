function pick(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] != null) return row[name];
  }
  return null;
}

async function safeQuery(pool, query) {
  try {
    return (await pool.request().query(query)).recordset;
  } catch (err) {
    if (err?.number === 208 || /Invalid object name/i.test(err?.message ?? "")) return [];
    throw err;
  }
}

/**
 * Normalize legacy PilotClub/PilotClubs rows to the singular shape consumed by buildPilotClubHistory.
 *
 * @param {Array<Record<string, unknown>>} rawRows
 * @returns {Array<{ID:unknown, Pilot_ID:unknown, Club_ID:unknown, JoinedAt:unknown, LeftAt:unknown}>}
 */
export function normalizePilotClubRows(rawRows) {
  return rawRows.map((row) => ({
    ID: pick(row, ["ID"]),
    Pilot_ID: pick(row, ["Pilot_ID", "PilotID"]),
    Club_ID: pick(row, ["Club_ID", "ClubID"]),
    JoinedAt: pick(row, ["JoinedAt"]),
    LeftAt: pick(row, ["LeftAt"]),
  }));
}

function compareIds(a, b) {
  const na = a == null ? Number.NEGATIVE_INFINITY : Number(a);
  const nb = b == null ? Number.NEGATIVE_INFINITY : Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) {
    return String(a ?? "").localeCompare(String(b ?? ""));
  }
  return na - nb;
}

/**
 * Query PilotClubs first (bacpac ground truth) and fall back to legacy PilotClub when absent.
 * `SELECT *` has no guaranteed row order, so the normalized rows are sorted by (Pilot_ID, ID)
 * — matching the legacy `ORDER BY pc.Pilot_ID, pc.ID` — to keep club-history output and the
 * dry-run byte-identical determinism check stable.
 *
 * @param {{request: () => {query: (sql:string) => Promise<{recordset:Array<Record<string, unknown>>}>}}} pool
 * @returns {Promise<Array<{ID:unknown, Pilot_ID:unknown, Club_ID:unknown, JoinedAt:unknown, LeftAt:unknown}>>}
 */
export async function queryPilotClubRows(pool) {
  let rows = await safeQuery(pool, "SELECT * FROM PilotClubs");
  if (rows.length === 0) rows = await safeQuery(pool, "SELECT * FROM PilotClub");
  return normalizePilotClubRows(rows).sort(
    (a, b) => compareIds(a.Pilot_ID, b.Pilot_ID) || compareIds(a.ID, b.ID),
  );
}

/**
 * Pure transformation: SQL PilotClub rows + lookup maps → Map<pilotId, memberships[]>.
 * No external dependencies — safe to import from any test context.
 *
 * @param {Array<{ID:number, Pilot_ID:number, Club_ID:number|null, JoinedAt:Date|null, LeftAt:Date|null}>} pilotClubRows
 * @param {Map<number,string>} pilotUuid  SQL pilot ID → UUID
 * @param {Map<number,string>} clubUuid   SQL club ID → UUID
 * @param {Array<{id:string, name:string}>} clubsList
 * @param {Array<{pilotId:string, currentSeasonClub:{clubId:string,clubName:string}|undefined}>} pilotsWithCurrentClub
 * @returns {Map<string, object[]>}
 */
export function buildPilotClubHistory(pilotClubRows, pilotUuid, clubUuid, clubsList, pilotsWithCurrentClub) {
  const historyByPilot = new Map();

  for (const r of pilotClubRows) {
    const pilotId = pilotUuid.get(r.Pilot_ID);
    const clubId = r.Club_ID ? clubUuid.get(r.Club_ID) : null;
    if (!pilotId || !clubId) continue;

    if (!historyByPilot.has(pilotId)) historyByPilot.set(pilotId, []);
    const clubDoc = clubsList.find((c) => c.id === clubId);
    historyByPilot.get(pilotId).push({
      pilotId,
      clubId,
      clubName: clubDoc?.name ?? "",
      joinedAt: r.JoinedAt ? new Date(r.JoinedAt).toISOString() : null,
      leftAt: r.LeftAt ? new Date(r.LeftAt).toISOString() : null,
      source: "legacy",
      legacyId: r.ID,
    });
  }

  for (const { pilotId, currentSeasonClub } of pilotsWithCurrentClub) {
    if (historyByPilot.has(pilotId)) continue;
    if (!currentSeasonClub) continue;
    historyByPilot.set(pilotId, [{
      pilotId,
      clubId: currentSeasonClub.clubId,
      clubName: currentSeasonClub.clubName,
      joinedAt: null,
      leftAt: null,
      source: "current",
    }]);
  }

  return historyByPilot;
}
