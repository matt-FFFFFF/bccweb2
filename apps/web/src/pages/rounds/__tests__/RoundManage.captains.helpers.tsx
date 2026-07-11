// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { CallerIdentity, Round } from "@bccweb/types";
import RoundManage from "../RoundManage.js";

export function renderPage() {
  render(
    <MemoryRouter initialEntries={["/rounds/round-1/manage"]}>
      <Routes>
        <Route path="/rounds/:id/manage" element={<RoundManage />} />
      </Routes>
    </MemoryRouter>,
  );
}

export function makeIdentity(overrides: Partial<CallerIdentity> = {}): CallerIdentity {
  return {
    userId: "user-1",
    email: "user@example.com",
    roles: ["Admin"],
    pilotId: null,
    clubId: "club-org",
    ...overrides,
  };
}

export function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
    date: "2026-06-09",
    status: "Confirmed",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Milk Hill" },
    organisingClub: { id: "club-org", name: "Org Club" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-org",
        teamName: "Org A",
        club: { id: "club-org", name: "Org Club" },
        score: 0,
        captainPilotId: null,
        pilots: [
          {
            placeInTeam: 1,
            pilotId: "pilot-1",
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            snapshot: null,
            flight: null,
          },
        ],
      },
      {
        id: "team-visit",
        teamName: "Visit A",
        club: { id: "club-visit", name: "Visit Club" },
        score: 0,
        captainPilotId: null,
        pilots: [
          {
            placeInTeam: 1,
            pilotId: "pilot-2",
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            snapshot: null,
            flight: null,
          },
        ],
      }
    ],
    ...overrides,
  };
}
