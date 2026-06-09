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
