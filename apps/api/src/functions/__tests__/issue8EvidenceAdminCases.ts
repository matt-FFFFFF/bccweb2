// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { CallSiteCase } from "./issue8EvidenceHarness.js";
import { adminOnly } from "./issue8EvidenceHarness.js";

export const ADMIN_CASES: readonly CallSiteCase[] = [
  { file: "admin.ts", handler: "recomputeRound", endpoint: "recomputeRound", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { id: randomUUID() }) },
  { file: "admin.ts", handler: "updateConfig", endpoint: "updateConfig", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", {}, { maxTeamsInClub: 2 }) },
  { file: "admin.ts", handler: "setUserRoles", endpoint: "setUserRoles", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { userId: randomUUID() }, { roles: ["Pilot"] }) },
  { file: "admin.ts", handler: "updateUserEmail", endpoint: "updateUserEmail", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { userId: randomUUID() }, { email: "issue8-new@example.test" }) },
  { file: "admin.ts", handler: "deleteUser", endpoint: "deleteUser", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { userId: randomUUID() }) },
  { file: "admin.ts", handler: "adminVerifyEmail", endpoint: "adminVerifyEmail", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { userId: randomUUID() }) },
  { file: "admin.ts", handler: "adminCreatePilotForUser", endpoint: "adminCreatePilotForUser", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { userId: randomUUID() }, { firstName: "Issue8", lastName: "Pilot" }) },
  { file: "adminWording.ts", handler: "addSignToFlyWording", endpoint: "addSignToFlyWording", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { markdown: "x" }) },
  { file: "clubs.ts", handler: "createClub", endpoint: "createClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { name: "Forbidden Club" }) },
  { file: "clubs.ts", handler: "updateClub", endpoint: "updateClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { id: randomUUID() }, { name: "Forbidden Club" }) },
  { file: "clubs.ts", handler: "deleteClub", endpoint: "deleteClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { id: randomUUID() }) },
  { file: "pilots.ts", handler: "createPilot", endpoint: "createPilot", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { firstName: "Forbidden", lastName: "Pilot" }) },
  { file: "seasonClubs.ts", handler: "createSeasonClub", endpoint: "createSeasonClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { year: "2026" }, { clubId: randomUUID(), numTeams: 1, acceptTsCs: true }) },
  { file: "seasonClubs.ts", handler: "updateSeasonClub", endpoint: "updateSeasonClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { year: "2026", seasonClubId: randomUUID() }, { numTeams: 1 }) },
  { file: "seasonClubs.ts", handler: "deleteSeasonClub", endpoint: "deleteSeasonClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { year: "2026", seasonClubId: randomUUID() }) },
  { file: "seasons.ts", handler: "createSeason", endpoint: "createSeason", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { year: 2026 }) },
  { file: "seasons.ts", handler: "updateSeason", endpoint: "updateSeason", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { year: "2026" }, { active: true }) },
  { file: "seasons.ts", handler: "deleteSeason", endpoint: "deleteSeason", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { year: "2026" }) },
];
