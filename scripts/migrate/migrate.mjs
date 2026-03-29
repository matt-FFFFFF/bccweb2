#!/usr/bin/env node
/**
 * migrate.mjs
 *
 * One-time migration: Azure SQL (BCCWeb) → Azure Blob Storage JSON.
 *
 * Usage:
 *   SQL_CONNECTION_STRING="Server=...;Database=...;User Id=...;Password=...;Encrypt=true;" \
 *   BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net" \
 *   node scripts/migrate/migrate.mjs
 *
 * For local dev against Azurite:
 *   SQL_CONNECTION_STRING="..." \
 *   BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" \
 *   node scripts/migrate/migrate.mjs
 *
 * Migration order (respects FK dependencies):
 *   1. config.json
 *   2. manufacturers.json
 *   3. pilot-ratings.json
 *   4. clubs.json + clubs/{uuid}.json
 *   5. sites.json + sites/{uuid}.json
 *   6. seasons.json (partial) + seasons/{year}.json (partial)
 *   7. pilots.json + pilots/{uuid}.json
 *   8. rounds.json + rounds/{uuid}.json (with teams/pilots/flights embedded)
 *   9. round-briefs/{uuid}.json
 *  10. Recompute seasons/{year}.json (league) + results/{year}.json
 */

import sql from "mssql";
import { BlobServiceClient } from "@azure/storage-blob";
import { v4 as uuidv4 } from "uuid";

// ─── Config ──────────────────────────────────────────────────────────────────

const SQL_CS = process.env.SQL_CONNECTION_STRING;
const BLOB_CS = process.env.BLOB_CONNECTION_STRING;
const CONTAINER = process.env.BLOB_CONTAINER ?? "data";
const DRY_RUN = process.env.DRY_RUN === "1";

if (!SQL_CS) {
  console.error("Missing SQL_CONNECTION_STRING env var");
  process.exit(1);
}
if (!BLOB_CS) {
  console.error("Missing BLOB_CONNECTION_STRING env var");
  process.exit(1);
}

// ─── Blob helpers ────────────────────────────────────────────────────────────

const blobService = BlobServiceClient.fromConnectionString(BLOB_CS);
const containerClient = blobService.getContainerClient(CONTAINER);

async function uploadBlob(path, obj) {
  const json = JSON.stringify(obj, null, 2);
  if (DRY_RUN) {
    console.log(`  [DRY] would write ${path} (${json.length} bytes)`);
    return;
  }
  const client = containerClient.getBlockBlobClient(path);
  await client.upload(json, Buffer.byteLength(json), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

// ─── Enum mappings ───────────────────────────────────────────────────────────

const COACH_TYPE_MAP = {
  0: "None",
  1: "ClubCoach",
  2: "SeniorCoach",
  3: "Instructor",
  4: "SeniorInstructor",
};

// Status descriptions from the SQL Statuses table:
// 1:Proposed, 2:Confirmed, 3:Cancelled, 4:Submitted, 5:Verified,
// 6:Active, 7:Inactive, 8:Locked, 9:Complete, 10:Deleted, 11:Brief Complete
// Round statuses used in new app: Proposed | Confirmed | BriefComplete | Locked | Complete | Cancelled
function mapStatus(description) {
  if (!description) return "Proposed";
  const d = description.trim();
  switch (d.toLowerCase()) {
    case "brief complete":
    case "briefcomplete":   return "BriefComplete";
    case "submitted":       return "Proposed";    // treat draft-submitted as Proposed
    case "verified":        return "Confirmed";   // verified ≈ confirmed
    case "deleted":         return "Cancelled";   // deleted rounds → Cancelled
    default:                return d;             // Proposed | Confirmed | Locked | Complete | Cancelled
  }
}

function mapSiteStatus(description) {
  if (!description) return "Active";
  return description.trim() === "Active" ? "Active" : "Inactive";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("BCCWeb SQL → Blob Migration");
  console.log(`  SQL: ${SQL_CS.replace(/Password=[^;]+/, "Password=***")}`);
  console.log(`  Blob container: ${CONTAINER}`);
  if (DRY_RUN) console.log("  DRY RUN — no blobs will be written");
  console.log("");

  // Connect to SQL
  const pool = await sql.connect(SQL_CS);
  console.log("Connected to SQL Server\n");

  // ID → UUID maps (populated as we migrate each entity)
  const clubUuid = new Map();      // SQL int ID → uuid
  const siteUuid = new Map();      // SQL int ID → uuid
  const seasonUuid = new Map();    // SQL int ID → uuid
  const pilotUuid = new Map();     // SQL int ID → uuid
  const roundUuid = new Map();     // SQL int ID → uuid
  const teamUuid = new Map();      // SQL int ID → uuid (Team table)
  const mfrUuid = new Map();       // SQL int ID → uuid
  const ratingUuid = new Map();    // SQL int ID → uuid

  // ── 1. config.json ─────────────────────────────────────────────────────────
  console.log("Step 1: config.json");
  // Config is stored in web.config AppSettings in the original app.
  // We write sensible defaults; the admin can update via admin UI post-migration.
  const config = {
    maxTeamsInClub: 2,
    maxPilotsInTeam: 12,
    maxScoringPilotsInTeam: 6,
    flightDateValidationEnabled: true,
    wingFactors: {
      "EN A": 1.0,
      "EN B": 0.9,
      "EN C": 0.8,
      "EN C 2-liner": 0.7,
      "EN D": 0.6,
      "EN D 2-liner": 0.5,
    },
  };
  await uploadBlob("config.json", config);
  console.log("  wrote config.json\n");

  // ── 2. Manufacturers ───────────────────────────────────────────────────────
  console.log("Step 2: manufacturers.json");
  const mfrs = await pool.request().query("SELECT ID, Name FROM Manufacturers ORDER BY Name");
  const manufacturersList = mfrs.recordset.map((r) => {
    const id = uuidv4();
    mfrUuid.set(r.ID, id);
    return { id, legacyId: r.ID, name: r.Name };
  });
  await uploadBlob("manufacturers.json", manufacturersList);
  for (const m of manufacturersList) {
    await uploadBlob(`manufacturers/${m.id}.json`, m);
  }
  console.log(`  wrote ${manufacturersList.length} manufacturers\n`);

  // ── 3. Pilot ratings ───────────────────────────────────────────────────────
  console.log("Step 3: pilot-ratings.json");
  const ratings = await pool.request().query("SELECT ID, Description FROM PilotRatings ORDER BY ID");
  const ratingsList = ratings.recordset.map((r) => {
    const id = uuidv4();
    ratingUuid.set(r.ID, id);
    return { id, legacyId: r.ID, description: r.Description };
  });
  await uploadBlob("pilot-ratings.json", ratingsList);
  console.log(`  wrote ${ratingsList.length} pilot ratings\n`);

  // ── 4. Clubs ───────────────────────────────────────────────────────────────
  console.log("Step 4: clubs.json + clubs/{uuid}.json");
  const clubs = await pool.request().query("SELECT ID, Name FROM Clubs ORDER BY Name");
  const clubsList = [];
  for (const r of clubs.recordset) {
    const id = uuidv4();
    clubUuid.set(r.ID, id);
    clubsList.push({ id, legacyId: r.ID, name: r.Name, sites: [], teams: [] });
  }
  await uploadBlob("clubs.json", clubsList.map(({ id, name }) => ({ id, name })));
  for (const c of clubsList) {
    await uploadBlob(`clubs/${c.id}.json`, c);
  }
  console.log(`  wrote ${clubsList.length} clubs\n`);

  // ── 5. Sites ───────────────────────────────────────────────────────────────
  console.log("Step 5: sites.json + sites/{uuid}.json");
  const sites = await pool
    .request()
    .query(`
      SELECT s.ID, s.Name, s.Club_ID, s.SiteGuideURL, s.ParkingW3W, s.BriefingW3W, s.TakeOffW3W,
             st.Description AS StatusDesc
      FROM Sites s
      LEFT JOIN Statuses st ON st.ID = s.StatusID
      ORDER BY s.Name
    `);
  const sitesList = [];
  for (const r of sites.recordset) {
    const id = uuidv4();
    siteUuid.set(r.ID, id);
    const clubId = r.Club_ID ? clubUuid.get(r.Club_ID) : null;
    const site = {
      id,
      legacyId: r.ID,
      name: r.Name,
      status: mapSiteStatus(r.StatusDesc),
      clubId: clubId ?? null,
      ...(r.ParkingW3W ? { parkingW3W: r.ParkingW3W } : {}),
      ...(r.BriefingW3W ? { briefingW3W: r.BriefingW3W } : {}),
      ...(r.TakeOffW3W ? { takeOffW3W: r.TakeOffW3W } : {}),
      ...(r.SiteGuideURL ? { guideUrl: r.SiteGuideURL } : {}),
    };
    sitesList.push(site);
    // Also link site → club document
    if (clubId) {
      const club = clubsList.find((c) => c.id === clubId);
      if (club && !club.sites.includes(id)) club.sites.push(id);
    }
  }
  await uploadBlob("sites.json", sitesList.map(({ id, name, status, clubId }) => ({ id, name, status, clubId })));
  for (const s of sitesList) {
    await uploadBlob(`sites/${s.id}.json`, s);
  }
  // Re-write club docs with updated sites arrays
  for (const c of clubsList) {
    await uploadBlob(`clubs/${c.id}.json`, c);
  }
  console.log(`  wrote ${sitesList.length} sites\n`);

  // ── 6. Seasons (partial) ───────────────────────────────────────────────────
  console.log("Step 6: seasons.json");
  const seasons = await pool
    .request()
    .query("SELECT ID, Year, active FROM Seasons ORDER BY Year");
  const seasonsList = [];
  for (const r of seasons.recordset) {
    const id = uuidv4();
    seasonUuid.set(r.ID, id);
    seasonsList.push({
      id,
      legacyId: r.ID,
      year: r.Year,
      active: !!r.active,
      rounds: [],
      leagueTable: [],
    });
  }
  await uploadBlob("seasons.json", seasonsList.map(({ id, year, active }) => ({ id, year, active })));
  console.log(`  wrote ${seasonsList.length} seasons\n`);

  // ── 7. Pilots ──────────────────────────────────────────────────────────────
  console.log("Step 7: pilots.json + pilots/{uuid}.json");
  const pilotsResult = await pool.request().query(`
    SELECT
      p.ID, p.BHPA_Number, p.CoachType, p.UserID,
      p.PureTrackLink, p.PureTrackID,
      p.HelmetColour, p.HarnessType, p.HarnessColour,
      p.EmergencyContactName, p.EmergencyPhoneNumber, p.MedicalInfo,
      p.WingModel, p.WingClass, p.WingColours,
      p.Pilot_Rating_ID,
      p.Manufacturer_ID AS MfrID,
      p.PersonID,
      per.FirstName, per.LastName, per.FullName, per.PhoneNumber,
      mfr.Name AS MfrName,
      u.Email AS UserEmail
    FROM Pilots p
    LEFT JOIN People per ON per.ID = p.PersonID
    LEFT JOIN Manufacturers mfr ON mfr.ID = p.Manufacturer_ID
    LEFT JOIN AspNetUsers u ON u.Id = p.UserID
    ORDER BY per.LastName, per.FirstName
  `);

  // PilotSeasonClubs
  const pscResult = await pool.request().query(`
    SELECT psc.pilot_ID, psc.season_ID, psc.club_ID, c.Name AS ClubName, s.Year AS SeasonYear
    FROM PilotSeasonClubs psc
    LEFT JOIN Clubs c ON c.ID = psc.club_ID
    LEFT JOIN Seasons s ON s.ID = psc.season_ID
  `);
  /** @type {Map<number, Array<{seasonYear:number, clubId:string, clubName:string}>>} */
  const pscBySqlPilotId = new Map();
  for (const r of pscResult.recordset) {
    if (!pscBySqlPilotId.has(r.pilot_ID)) pscBySqlPilotId.set(r.pilot_ID, []);
    const clubId = r.club_ID ? clubUuid.get(r.club_ID) : null;
    if (clubId) {
      pscBySqlPilotId.get(r.pilot_ID).push({
        seasonYear: r.SeasonYear,
        clubId,
        clubName: r.ClubName ?? "",
      });
    }
  }

  const pilotsSummary = [];
  for (const r of pilotsResult.recordset) {
    const id = uuidv4();
    pilotUuid.set(r.ID, id);

    const seasonClubs = pscBySqlPilotId.get(r.ID) ?? [];
    // Current club = most recent season club
    const currentSeasonClub = [...seasonClubs].sort((a, b) => b.seasonYear - a.seasonYear)[0];

    const fullName =
      r.FullName?.trim() ||
      [r.FirstName, r.LastName].filter(Boolean).join(" ") ||
      "Unknown";
    const firstName = r.FirstName?.trim() ?? "";
    const lastName = r.LastName?.trim() ?? "";

    const ratingEntry = ratingsList.find((x) => x.legacyId === r.Pilot_Rating_ID);
    const pilotRating = ratingEntry?.description ?? "Pilot";

    const coachType = COACH_TYPE_MAP[r.CoachType] ?? "None";

    const mfrId = r.MfrID ? mfrUuid.get(r.MfrID) : null;
    const wingManufacturer = mfrId
      ? { id: mfrId, name: r.MfrName }
      : undefined;

    const pilotDoc = {
      id,
      legacyId: r.ID,
      ...(r.BHPA_Number != null ? { bhpaNumber: r.BHPA_Number } : {}),
      coachType,
      pilotRating,
      ...(r.PureTrackID ? { pureTrackId: r.PureTrackID } : {}),
      ...(r.PureTrackLink ? { pureTrackLink: r.PureTrackLink } : {}),
      ...(r.HelmetColour ? { helmetColour: r.HelmetColour } : {}),
      ...(r.HarnessType ? { harnessType: r.HarnessType } : {}),
      ...(r.HarnessColour ? { harnessColour: r.HarnessColour } : {}),
      ...(r.EmergencyContactName ? { emergencyContactName: r.EmergencyContactName } : {}),
      ...(r.EmergencyPhoneNumber ? { emergencyPhoneNumber: r.EmergencyPhoneNumber } : {}),
      ...(r.MedicalInfo ? { medicalInfo: r.MedicalInfo } : {}),
      ...(r.WingClass ? { wingClass: r.WingClass } : {}),
      ...(wingManufacturer ? { wingManufacturer } : {}),
      ...(r.WingModel ? { wingModel: r.WingModel } : {}),
      ...(r.WingColours ? { wingColours: r.WingColours } : {}),
      person: {
        id: uuidv4(),
        firstName,
        lastName,
        fullName,
        ...(r.PhoneNumber ? { phoneNumber: r.PhoneNumber } : {}),
      },
      ...(currentSeasonClub
        ? { currentClub: { id: currentSeasonClub.clubId, name: currentSeasonClub.clubName } }
        : {}),
      seasonClubs,
      // email sourced from AspNetUser — used for pilot auto-linking at registration
      ...(r.UserEmail ? { email: r.UserEmail } : {}),
      userId: null, // no user accounts migrated — pilots self-register post-migration
    };

    await uploadBlob(`pilots/${id}.json`, pilotDoc);

    pilotsSummary.push({
      id,
      legacyId: r.ID,
      ...(r.BHPA_Number != null ? { bhpaNumber: r.BHPA_Number } : {}),
      name: fullName,
      ...(r.UserEmail ? { email: r.UserEmail } : {}),
      clubId: currentSeasonClub?.clubId ?? null,
      rating: pilotRating,
      userId: null,
    });
  }
  await uploadBlob("pilots.json", pilotsSummary);
  console.log(`  wrote ${pilotsSummary.length} pilots\n`);

  // ── 8. Rounds (with teams, pilot slots, flights) ───────────────────────────
  console.log("Step 8: rounds.json + rounds/{uuid}.json");

  // Fetch all rounds
  const roundsResult = await pool.request().query(`
    SELECT
      r.ID, r.Date, r.isLocked, r.MaxTeams, r.MinimumScore,
      r.BriefingTime, r.LandByTime, r.CheckInByTime,
      r.Narrative, r.PureTrackGroupName, r.PureTrackGroupSlug, r.PureTrackGroup_ID,
      r.OrganisingClub_ID, r.Season_ID,
      s.ID AS SiteID, s.Name AS SiteName, s.ParkingW3W, s.BriefingW3W, s.TakeOffW3W,
      st.Description AS StatusDesc,
      sea.Year AS SeasonYear
    FROM Rounds r
    LEFT JOIN Sites s ON s.ID = r.SiteID
    LEFT JOIN Statuses st ON st.ID = r.StatusID
    LEFT JOIN Seasons sea ON sea.ID = r.Season_ID
    ORDER BY r.Date
  `);

  // Fetch all round teams
  const rtResult = await pool.request().query(`
    SELECT rt.ID, rt.RoundID, rt.TeamID, rt.TeamScore,
           rt.PureTrackGroupName, rt.PureTrackGroupSlug, rt.PureTrackGroup_ID,
           t.TeamName, t.ClubID
    FROM RoundTeams rt
    LEFT JOIN Teams t ON t.ID = rt.TeamID
  `);

  // Fetch all round team places (pilot slots)
  const rtpResult = await pool.request().query(`
    SELECT rp.ID, rp.PlaceInTeam, rp.IsScoring, rp.Status, rp.RoundTeam_ID,
           rp.RoundTeamPilot_ID,
           rtp.Pilot_ID, rtp.noScore, rtp.PilotPoints, rtp.PhoneNumber,
           rtp.WingClass, rtp.WingColours, rtp.WingModel,
           rtp.HelmetColour, rtp.HarnessType, rtp.HarnessColour,
           rtp.EmergencyContactName, rtp.EmergencyPhoneNumber, rtp.MedicalInfo,
           rtp.AccountedFor, rtp.SignToFly,
           rtp.Manufacturer_ID,
           pr.Description AS PilotRatingDesc
    FROM RoundTeamPlaces rp
    LEFT JOIN RoundTeamPilots rtp ON rtp.ID = rp.RoundTeamPilot_ID
    LEFT JOIN PilotRatings pr ON pr.ID = rtp.Pilot_Rating_ID
  `);

  // Fetch all flights
  const flightResult = await pool.request().query(`
    SELECT f.ID, f.PilotID, f.RoundID, f.DateTime, f.Distance, f.url, f.ScoringType,
           f.isManualLog, f.ManualLogJustification,
           f.IsOverallPB, f.AwardedOverallPB,
           f.IsUKPersonalBest, f.AwardedUKPersonalBest,
           f.IsFirstXC, f.AwardedFirstXC,
           f.IsFirstUKXC, f.AwardedFirstUKXC,
           f.roundTeamPlace_ID AS RTPPlaceID,
           rp.RoundTeam_ID
    FROM Flights f
    LEFT JOIN RoundTeamPlaces rp ON rp.ID = f.roundTeamPlace_ID
  `);

  // Index structures for fast lookups
  const rtByRound = new Map();       // RoundID → RoundTeam[]
  const rtpByRoundTeam = new Map();  // RoundTeam.ID → RoundTeamPlace[]
  const flightByPlace = new Map();   // RoundTeamPlace.ID → Flight
  const flightByRoundPilot = new Map(); // `${roundId}:${pilotSqlId}` → Flight

  for (const r of rtResult.recordset) {
    if (!rtByRound.has(r.RoundID)) rtByRound.set(r.RoundID, []);
    rtByRound.get(r.RoundID).push(r);
    teamUuid.set(r.ID, uuidv4());
  }
  for (const r of rtpResult.recordset) {
    if (!rtpByRoundTeam.has(r.RoundTeam_ID)) rtpByRoundTeam.set(r.RoundTeam_ID, []);
    rtpByRoundTeam.get(r.RoundTeam_ID).push(r);
  }
  for (const f of flightResult.recordset) {
    if (f.RTPPlaceID) flightByPlace.set(f.RTPPlaceID, f);
    flightByRoundPilot.set(`${f.RoundID}:${f.PilotID}`, f);
  }

  const roundsSummary = [];
  /** @type {Map<string, object>} uuid → full scored round doc (for step 10) */
  const roundDocs = new Map();

  for (const r of roundsResult.recordset) {
    const id = uuidv4();
    roundUuid.set(r.ID, id);

    const siteId = r.SiteID ? siteUuid.get(r.SiteID) : null;
    const orgClubId = r.OrganisingClub_ID ? clubUuid.get(r.OrganisingClub_ID) : null;
    const orgClub = orgClubId
      ? clubsList.find((c) => c.id === orgClubId)
      : null;
    const seasonYear = r.SeasonYear ?? null;

    // Build teams
    const roundTeamRows = rtByRound.get(r.ID) ?? [];
    const teams = roundTeamRows.map((rt) => {
      const rtId = teamUuid.get(rt.ID);
      const clubId = rt.ClubID ? clubUuid.get(rt.ClubID) : null;
      const clubDoc = clubId ? clubsList.find((c) => c.id === clubId) : null;

      const places = (rtpByRoundTeam.get(rt.ID) ?? []).sort((a, b) => a.PlaceInTeam - b.PlaceInTeam);

      const pilots = places.map((place) => {
        const pilotSqlId = place.Pilot_ID ?? null;
        const pilotId = pilotSqlId ? pilotUuid.get(pilotSqlId) : null;
        const hasPilot = !!place.RoundTeamPilot_ID;

        // Flight — try place-based lookup first, fall back to round+pilot
        const flight = place.ID
          ? (flightByPlace.get(place.ID) ?? (pilotSqlId ? flightByRoundPilot.get(`${r.ID}:${pilotSqlId}`) : null))
          : (pilotSqlId ? flightByRoundPilot.get(`${r.ID}:${pilotSqlId}`) : null);

        const snapshot = hasPilot
          ? {
              wingClass: place.WingClass ?? "EN B",
              pilotRating: place.PilotRatingDesc ?? "Pilot",
              ...(place.PhoneNumber ? { phoneNumber: place.PhoneNumber } : {}),
              ...(place.HelmetColour ? { helmetColour: place.HelmetColour } : {}),
              ...(place.HarnessType ? { harnessType: place.HarnessType } : {}),
              ...(place.HarnessColour ? { harnessColour: place.HarnessColour } : {}),
              ...(place.Manufacturer_ID ? { wingManufacturer: mfrUuid.get(place.Manufacturer_ID) ?? null } : {}),
              ...(place.WingModel ? { wingModel: place.WingModel } : {}),
              ...(place.WingColours ? { wingColours: place.WingColours } : {}),
              ...(place.EmergencyContactName ? { emergencyContactName: place.EmergencyContactName } : {}),
              ...(place.EmergencyPhoneNumber ? { emergencyPhoneNumber: place.EmergencyPhoneNumber } : {}),
              ...(place.MedicalInfo ? { medicalInfo: place.MedicalInfo } : {}),
            }
          : null;

        const flightDoc = flight
          ? {
              id: uuidv4(),
              distance: Number(flight.Distance) || 0,
              url: flight.url ?? null,
              dateTime: flight.DateTime ? new Date(flight.DateTime).toISOString() : null,
              scoringType: flight.ScoringType ?? "XC",
              score: 0, // recomputed below if round is Complete
              wingFactor: 1.0,
              isManualLog: !!flight.isManualLog,
              ...(flight.ManualLogJustification ? { manualLogJustification: flight.ManualLogJustification } : {}),
              ...(flight.IsFirstXC ? { isFirstXC: true } : {}),
              ...(flight.IsFirstUKXC ? { isFirstUKXC: true } : {}),
              ...(flight.IsUKPersonalBest ? { isUKPersonalBest: true } : {}),
              ...(flight.IsOverallPB ? { isOverallPB: true } : {}),
              ...(flight.AwardedFirstXC ? { awardedFirstXC: true } : {}),
              ...(flight.AwardedFirstUKXC ? { awardedFirstUKXC: true } : {}),
              ...(flight.AwardedUKPersonalBest ? { awardedUKPB: true } : {}),
              ...(flight.AwardedOverallPB ? { awardedOverallPB: true } : {}),
            }
          : null;

        return {
          placeInTeam: place.PlaceInTeam,
          isScoring: !!place.IsScoring,
          status: hasPilot ? "Filled" : "Empty",
          accountedFor: hasPilot ? !!place.AccountedFor : false,
          signToFly: hasPilot ? !!place.SignToFly : false,
          noScore: hasPilot ? !!place.noScore : false,
          pilotPoints: hasPilot ? (Number(place.PilotPoints) || 0) : 0,
          pilotId,
          snapshot,
          flight: flightDoc,
        };
      });

      return {
        id: rtId,
        teamName: rt.TeamName ?? "",
        club: clubDoc ? { id: clubDoc.id, name: clubDoc.name } : { id: null, name: "" },
        score: Number(rt.TeamScore) || 0,
        ...(rt.PureTrackGroup_ID ? { pureTrackGroupId: rt.PureTrackGroup_ID } : {}),
        ...(rt.PureTrackGroupSlug ? { pureTrackGroupSlug: rt.PureTrackGroupSlug } : {}),
        pilots,
      };
    });

    const status = mapStatus(r.StatusDesc);

    const roundDoc = {
      id,
      legacyId: r.ID,
      date: r.Date ? new Date(r.Date).toISOString().slice(0, 10) : null,
      status,
      isLocked: !!r.isLocked,
      maxTeams: r.MaxTeams ?? 8,
      minimumScore: r.MinimumScore ?? 0,
      ...(r.BriefingTime ? { briefingTime: new Date(r.BriefingTime).toTimeString().slice(0, 5) } : {}),
      ...(r.LandByTime ? { landByTime: new Date(r.LandByTime).toTimeString().slice(0, 5) } : {}),
      ...(r.CheckInByTime ? { checkInByTime: new Date(r.CheckInByTime).toTimeString().slice(0, 5) } : {}),
      ...(r.Narrative ? { narrative: r.Narrative } : {}),
      ...(r.PureTrackGroup_ID ? { pureTrackGroupId: r.PureTrackGroup_ID } : {}),
      ...(r.PureTrackGroupName && r.PureTrackGroupName !== "Not set yet..."
        ? { pureTrackGroupName: r.PureTrackGroupName }
        : {}),
      ...(r.PureTrackGroupSlug && r.PureTrackGroupSlug !== "Not set yet..."
        ? { pureTrackGroupSlug: r.PureTrackGroupSlug }
        : {}),
      site: {
        id: siteId ?? null,
        name: r.SiteName ?? "",
        ...(r.ParkingW3W ? { parkingW3W: r.ParkingW3W } : {}),
        ...(r.BriefingW3W ? { briefingW3W: r.BriefingW3W } : {}),
        ...(r.TakeOffW3W ? { takeOffW3W: r.TakeOffW3W } : {}),
      },
      ...(orgClub ? { organisingClub: { id: orgClub.id, name: orgClub.name } } : {}),
      season: { year: seasonYear },
      teams,
    };

    await uploadBlob(`rounds/${id}.json`, roundDoc);

    // Apply scoring for completed rounds
    if (status === "Complete") {
      scoreRound(roundDoc, config);
      // Re-write with scored data
      await uploadBlob(`rounds/${id}.json`, roundDoc);
    }

    // Retain in memory for step 10 league/results computation
    roundDocs.set(id, roundDoc);

    roundsSummary.push({
      id,
      legacyId: r.ID,
      date: roundDoc.date,
      siteId: siteId ?? null,
      siteName: r.SiteName ?? "",
      status,
      seasonYear,
    });

    // Link round → season
    if (r.Season_ID) {
      const season = seasonsList.find((s) => s.legacyId === r.Season_ID);
      if (season && !season.rounds.includes(id)) season.rounds.push(id);
    }
  }

  await uploadBlob("rounds.json", roundsSummary);
  console.log(`  wrote ${roundsSummary.length} rounds\n`);

  // ── 9. Round briefs ────────────────────────────────────────────────────────
  console.log("Step 9: round-briefs/{uuid}.json");
  const briefResult = await pool.request().query(`
    SELECT rb.ID, rb.RoundID, rb.SiteName, rb.BrieferName,
           rb.BrieferBHPA_CoachLevel, rb.BrieferBHPA_Number, rb.BrieferPhoneNumber,
           rb.BrieferEmailAddress, rb.RoundDate, rb.OrganisingClubName,
           rb.BriefingTime, rb.LandByTime, rb.CheckInByTime,
           rb.NumTeamsInRound, rb.NumPilotsInRound,
           rb.WindSpeed_Direction, rb.DirectionOfFlight, rb.ExpectedLandingArea,
           rb.AirspaceAndHazards, rb.NOTAMs, rb.BENO_LineDescription, rb.BriefersNotes
    FROM RoundBriefs rb
  `);
  let briefCount = 0;
  for (const r of briefResult.recordset) {
    const roundId = roundUuid.get(r.RoundID);
    if (!roundId) continue;
    const brief = {
      roundId,
      generatedAt: new Date().toISOString(),
      data: {
        siteName: r.SiteName,
        brieferName: r.BrieferName,
        brieferBhpaCoachLevel: r.BrieferBHPA_CoachLevel,
        brieferBhpaNumber: r.BrieferBHPA_Number,
        brieferPhoneNumber: r.BrieferPhoneNumber,
        brieferEmailAddress: r.BrieferEmailAddress,
        roundDate: r.RoundDate ? new Date(r.RoundDate).toISOString().slice(0, 10) : null,
        organisingClubName: r.OrganisingClubName,
        briefingTime: r.BriefingTime ? new Date(r.BriefingTime).toTimeString().slice(0, 5) : null,
        landByTime: r.LandByTime ? new Date(r.LandByTime).toTimeString().slice(0, 5) : null,
        checkInByTime: r.CheckInByTime ? new Date(r.CheckInByTime).toTimeString().slice(0, 5) : null,
        numTeamsInRound: r.NumTeamsInRound,
        numPilotsInRound: r.NumPilotsInRound,
        windSpeedDirection: r.WindSpeed_Direction,
        directionOfFlight: r.DirectionOfFlight,
        expectedLandingArea: r.ExpectedLandingArea,
        airspaceAndHazards: r.AirspaceAndHazards,
        notams: r.NOTAMs,
        benoLineDescription: r.BENO_LineDescription,
        briefersNotes: r.BriefersNotes,
      },
    };
    await uploadBlob(`round-briefs/${roundId}.json`, brief);
    briefCount++;
  }
  console.log(`  wrote ${briefCount} round briefs\n`);

  // ── 10. Recompute seasons/{year}.json and results/{year}.json ──────────────
  console.log("Step 10: recompute seasons/{year}.json + results/{year}.json");

  for (const season of seasonsList) {
    // Collect in-memory round docs for this season
    const seasonRoundDocs = season.rounds
      .map((id) => roundDocs.get(id))
      .filter(Boolean);

    const leagueTable = computeLeague(seasonRoundDocs);
    season.leagueTable = leagueTable;

    await uploadBlob(`seasons/${season.year}.json`, {
      id: season.id,
      year: season.year,
      active: season.active,
      rounds: season.rounds,
      leagueTable,
    });

    // results/{year}.json — per-round results
    const pilotNameMap = Object.fromEntries(pilotsSummary.map((p) => [p.id, p.name]));
    const results = buildSeasonResults(season, roundDocs, pilotNameMap);
    await uploadBlob(`results/${season.year}.json`, results);

    console.log(
      `  season ${season.year}: ${leagueTable.length} teams in league, ${results.length} round results`
    );
  }

  await pool.close();
  console.log("\nMigration complete.");
}

// ─── scoreRound — ported from packages/scoring/src/index.ts ──────────────────

/**
 * Compute pilot and team scores for a round, mutating in-place.
 * Called during migration for all Complete rounds.
 *
 * @param {object} roundDoc
 * @param {object} config
 */
function scoreRound(roundDoc, config) {
  for (const team of roundDoc.teams) {
    const scoringSlots = [];
    for (const slot of team.pilots) {
      if (!slot.flight || slot.noScore || !slot.snapshot?.wingClass) {
        slot.pilotPoints = 0;
        continue;
      }
      const factor = config.wingFactors[slot.snapshot.wingClass] ?? 1.0;
      const score = Math.round(slot.flight.distance * factor * 10) / 10;
      slot.flight.wingFactor = factor;
      slot.flight.score = score;
      slot.pilotPoints = score;
      if (slot.isScoring) scoringSlots.push(slot);
    }
    const counted = scoringSlots
      .sort((a, b) => b.pilotPoints - a.pilotPoints)
      .slice(0, config.maxScoringPilotsInTeam);
    team.score = Math.round(
      counted.reduce((sum, s) => sum + s.pilotPoints, 0) * 10
    ) / 10;
  }
}

// ─── computeLeague — ported from packages/scoring/src/index.ts ───────────────

/**
 * Aggregate team scores across all Complete rounds and return a ranked league
 * table. Exact port of the TypeScript implementation in packages/scoring.
 *
 * @param {object[]} rounds  In-memory round docs (may include non-Complete).
 * @returns {object[]}
 */
function computeLeague(rounds) {
  const completeRounds = rounds.filter((r) => r.status === "Complete");
  /** @type {Map<string, object>} "clubId|teamName" → entry */
  const entryMap = new Map();

  for (const round of completeRounds) {
    for (const team of round.teams) {
      const key = `${team.club.id}|${team.teamName}`;
      if (!entryMap.has(key)) {
        entryMap.set(key, {
          rank: 0,
          clubId: team.club.id,
          clubName: team.club.name,
          teamName: team.teamName,
          totalScore: 0,
          roundScores: {},
          countedRounds: 0,
        });
      }
      const entry = entryMap.get(key);
      if (team.score > 0) {
        entry.roundScores[round.id] = team.score;
        entry.totalScore = Math.round((entry.totalScore + team.score) * 10) / 10;
        entry.countedRounds += 1;
      }
    }
  }

  const sorted = Array.from(entryMap.values()).sort(
    (a, b) => b.totalScore - a.totalScore
  );
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].totalScore < sorted[i - 1].totalScore) rank = i + 1;
    sorted[i].rank = rank;
  }
  return sorted;
}

// ─── buildSeasonResults — ported from apps/api/src/lib/recompute.ts ──────────

/**
 * Build results/{year}.json content from in-memory round docs.
 *
 * @param {object}            season       Season record (has .rounds array of UUIDs)
 * @param {Map<string,object>} allRoundDocs uuid → round doc
 * @param {Record<string,string>} pilotNameMap pilotId → display name
 * @returns {object[]}
 */
function buildSeasonResults(season, allRoundDocs, pilotNameMap) {
  const completeRounds = season.rounds
    .map((id) => allRoundDocs.get(id))
    .filter((r) => r && r.status === "Complete")
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  return completeRounds.map((round) => ({
    roundId: round.id,
    date: round.date,
    siteName: round.site.name,
    teamResults: round.teams
      .sort((a, b) => b.score - a.score)
      .map((team, i) => ({
        rank: i + 1,
        teamName: team.teamName,
        clubName: team.club.name,
        score: team.score,
        pilots: team.pilots
          .filter((p) => p.flight != null && p.snapshot != null)
          .sort((a, b) => b.pilotPoints - a.pilotPoints)
          .map((slot) => ({
            pilotName: slot.pilotId
              ? (pilotNameMap[slot.pilotId] ?? slot.pilotId)
              : "Unknown",
            distance: slot.flight.distance,
            score: slot.pilotPoints,
            wingClass: slot.snapshot.wingClass,
          })),
      })),
  }));
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\nMigration failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
