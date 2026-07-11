import { test, expect } from "vitest";
import { invoke, makeAuthRequest } from "./helpers/api.js";
import "./helpers/azurite.js"; // handles beforeAll/afterAll
import { makeUser, makeRound, makeClub, makePilot, readPrivateJson } from "./helpers/seed.js";
import { Round } from "@bccweb/types";
import "../functions/teamsCaptain.js"; // register

test("setTeamCaptain: coordinator can set captain for own club's team, but not another club's", async () => {
  const orgClub = await makeClub({ name: "Org Club" });
  const visitClub = await makeClub({ name: "Visit Club" });
  
  const coordUser = (await makeUser({ roles: ["RoundsCoord"], clubId: visitClub.id })).user;
  
  const pilot = await makePilot({ clubId: visitClub.id });
  const otherPilot = await makePilot({ clubId: orgClub.id });

  const round = await makeRound({
    organisingClubId: orgClub.id,
    teams: [
      {
        id: "team-visit",
        club: { id: visitClub.id, name: visitClub.name },
        teamName: "Visit A",
        score: 0,
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId: pilot.id, isScoring: true, accountedFor: false }
        ]
      },
      {
        id: "team-org",
        club: { id: orgClub.id, name: orgClub.name },
        teamName: "Org A",
        score: 0,
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId: otherPilot.id, isScoring: true, accountedFor: false }
        ]
      }
    ]
  });

  // Visiting coord setting captain for their own team (even though they don't organise the round) -> should 200
  const reqOwn = makeAuthRequest(coordUser.id, coordUser.email, {
    method: "PUT",
    params: { id: round.id, teamId: "team-visit" },
    body: { pilotId: pilot.id }
  });
  const resOwn = await invoke("setTeamCaptain", reqOwn);
  
  // Right now this will FAIL and return 403 because the API checks round.organisingClub.id
  expect(resOwn.status).toBe(200);

  const updatedRound = await readPrivateJson<Round>(`rounds/${round.id}.json`);
  expect(updatedRound?.teams.find(t => t.id === "team-visit")?.captainPilotId).toBe(pilot.id);

  // Visiting coord trying to set captain for the other club's team -> should 403
  const reqCross = makeAuthRequest(coordUser.id, coordUser.email, {
    method: "PUT",
    params: { id: round.id, teamId: "team-org" },
    body: { pilotId: otherPilot.id }
  });
  const resCross = await invoke("setTeamCaptain", reqCross);
  expect(resCross.status).toBe(403);
  
  // Persisted captain unchanged on denial
  const unmodifiedRound = await readPrivateJson<Round>(`rounds/${round.id}.json`);
  expect(unmodifiedRound?.teams.find(t => t.id === "team-org")?.captainPilotId).toBeUndefined();
});

test("setTeamCaptain: admin can set captain for any team", async () => {
  const adminUser = (await makeUser({ roles: ["Admin"] })).user;
  const club = await makeClub();
  const pilot = await makePilot({ clubId: club.id });
  const round = await makeRound({
    teams: [
      {
        id: "team1",
        club: { id: club.id, name: club.name },
        teamName: "Team 1",
        score: 0,
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId: pilot.id, isScoring: true, accountedFor: false }
        ]
      }
    ]
  });

  const req = makeAuthRequest(adminUser.id, adminUser.email, {
    method: "PUT",
    params: { id: round.id, teamId: "team1" },
    body: { pilotId: pilot.id }
  });
  const res = await invoke("setTeamCaptain", req);
  expect(res.status).toBe(200);
});
