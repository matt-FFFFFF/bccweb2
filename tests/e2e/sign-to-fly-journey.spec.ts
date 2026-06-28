import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const EVIDENCE_DIR = path.join(".omo", "evidence", "e2e-sign-to-fly");
const YEAR = 2026;
const ROUND_ID = "round-sign-to-fly";
const TEAM_ID = "team-alpha";
const CLUB_ID = "club-alpha";
const PILOT_A_ID = "pilot-a";
const PILOT_B_ID = "pilot-b";
const ADMIN_ID = "admin-user";
const COORD_ID = "coord-user";
const PASSWORD = "CorrectHorse123!";

type Role = "Pilot" | "Admin" | "RoundsCoord";

interface Identity {
  userId: string;
  email: string;
  roles: Role[];
  pilotId: string | null;
  clubId: string | null;
  firstLoginOfSeason?: boolean;
  activeSeasonYear?: number;
}

interface PilotSlot {
  placeInTeam: number;
  pilotId: string | null;
  status: "Filled" | "Empty";
  isScoring: boolean;
  accountedFor: boolean;
  signToFly: boolean;
  noScore: boolean;
  pilotPoints: number;
  snapshot: unknown | null;
  flight: unknown | null;
}

interface RoundState {
  status: string;
  isLocked: boolean;
  date: string;
  site: { id: string; name: string; [key: string]: unknown };
  teams: { pilots: PilotSlot[]; [key: string]: unknown }[];
  [key: string]: unknown;
}

interface BriefState {
  version: number;
  [key: string]: unknown;
}

interface E2EState {
  identities: Record<string, Identity>;
  round: RoundState;
  brief: BriefState;
  wording: unknown;
  signatures: unknown[];
  lastRegisteredEmail: string | null;
  issuedTokens: Record<string, string>;
  pureTrackMocked: boolean;
  pdfGenerated: boolean;
  leagueRecomputed: boolean;
}

test.beforeEach(async ({ page }) => {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await mockBackend(page, createState());
});

test.describe("sign-to-fly journey", () => {
  test("happy path: register, verify, login, skip gate, sign to fly, confirmation", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: /create account/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "01-register-form");

    const email = `new-pilot-${Date.now()}@example.test`;
    await page.getByLabel(/email address/i).fill(email);
    await page.locator("#register-password").fill(PASSWORD);
    await page.locator("#register-confirm").fill(PASSWORD);
    await page.getByLabel(/terms/i).check();
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 5000 });
    await shot(page, "02-register-check-email");

    await page.goto("/verify-email?token=mock-acs-token");
    await expect(page.getByRole("heading", { name: /email verified/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "03-verify-email");

    await login(page, "pilot-a@example.test", PASSWORD);
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "04-first-login-gate");
    await page.getByRole("button", { name: /skip for now/i }).click();

    await page.goto(`/rounds/${ROUND_ID}`);
    await expect(page.getByRole("link", { name: /sign to fly/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "05-round-detail-sign-cta");

    await page.getByRole("link", { name: /sign to fly/i }).click();
    await expect(page.getByRole("heading", { name: /sign to fly/i })).toBeVisible({ timeout: 5000 });
    
    const summaryCard = page.getByTestId("briefing-summary");
    await expect(summaryCard).toBeVisible();
    await expect(summaryCard).toContainText("Briefing summary");
    await expect(summaryCard).toContainText("Site Name: Milk Hill");
    await expect(summaryCard).toContainText("Wind Speed/Direction: SW 10-15");
    await expect(summaryCard).toContainText("Direction of Flight: North ridge");
    await expect(summaryCard).toContainText("Expected Landing Area: Main bottom landing field");
    await expect(summaryCard).toContainText("Airspace and Hazards: Avoid the village and power lines");
    await expect(summaryCard).toContainText("NOTAMs: No active NOTAMs");
    await expect(summaryCard).toContainText("BENO Line Description: Standard BENO line");
    await expect(summaryCard).toContainText("Briefer Contact: Chief Briefer - 07700 900000");
    await expect(summaryCard).toContainText("Frequency: 144.45 MHz");
    await expect(summaryCard.getByRole("link", { name: /view full brief/i })).toBeVisible();
    await expect(summaryCard.locator("img")).toHaveCount(2);

    await expect(page.getByRole("heading", { name: /legal acceptance text/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "06-sign-to-fly-legal-text");

    await page.getByLabel(/i have read and understood/i).check();
    await shot(page, "07-sign-to-fly-consent-checked");
    await page.getByRole("button", { name: /sign to fly/i }).click();

    await expect(page.getByRole("heading", { name: /signed successfully/i })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/brief version/i)).toBeVisible({ timeout: 5000 });
    await shot(page, "08-sign-confirmation");
  });

  test("pilot signs other's slot: direct URL shows not-yours message", async ({ page }) => {
    await login(page, "pilot-a@example.test", PASSWORD, { skipGate: true });
    await page.goto(`/rounds/${ROUND_ID}/sign/${TEAM_ID}/2`);
    await expect(page.getByText(/this slot is not yours/i)).toBeVisible({ timeout: 5000 });
    await shot(page, "09-not-your-slot");
  });

  test("sign before BriefComplete: round not ready and no submit button", async ({ page }) => {
    await login(page, "pilot-a@example.test", PASSWORD, { skipGate: true, status: "Confirmed" });
    await page.goto(`/rounds/${ROUND_ID}/sign/${TEAM_ID}/1`);
    await expect(page.getByText(/not yet ready/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /sign to fly/i })).toHaveCount(0);
    await shot(page, "10-not-ready-before-brief-complete");
  });

  test("admin lock: RoundManage Lock generates PDF and status becomes Locked", async ({ page }) => {
    await login(page, "admin@example.test", PASSWORD, { skipGate: true });
    await page.goto(`/rounds/${ROUND_ID}/manage`);
    await expect(page.getByRole("button", { name: /lock round/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "11-admin-before-lock");
    await page.getByRole("button", { name: /lock round/i }).click();

    await expect(page.getByText(/locked/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("link", { name: /view brief/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "12-admin-locked-pdf-ready");
  });

  test("admin material brief edit invalidates existing signatures", async ({ page }) => {
    await login(page, "admin@example.test", PASSWORD, { skipGate: true, signedSlots: [1, 2] });
    await page.goto(`/rounds/${ROUND_ID}/brief/edit`);
    await expect(page.getByRole("heading", { name: /edit round brief/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "13-material-edit-form");

    await page.locator("label", { hasText: /notams/i }).locator("xpath=..").locator("textarea").fill("Material NOTAM update: airspace restriction active.");
    await page.getByRole("button", { name: /save brief/i }).click();
    await expect(page.getByText(/invalidate\s+2/i)).toBeVisible({ timeout: 5000 });
    await shot(page, "14-material-invalidate-modal");
    await page.getByRole("button", { name: /confirm & invalidate/i }).click();
    await expect(page).toHaveURL(new RegExp(`/rounds/${ROUND_ID}/brief`), { timeout: 5000 });

    const invalidatedRound = await page.evaluate(async (roundId) => {
      const res = await fetch(`/api/rounds/${roundId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("bcc_access_token")}` },
      });
      return res.json();
    }, ROUND_ID) as { teams: Array<{ pilots: Array<{ signToFly: boolean }> }> };
    expect(invalidatedRound.teams[0].pilots.every((slot) => slot.signToFly === false)).toBe(true);
    await page.goto(`/rounds/${ROUND_ID}/manage`);
    await expect(page.getByRole("heading", { name: /milk hill/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "15-material-signatures-reset");
  });

  test("admin cosmetic brief edit preserves existing signatures", async ({ page }) => {
    await login(page, "admin@example.test", PASSWORD, { skipGate: true, signedSlots: [1, 2] });
    await page.goto(`/rounds/${ROUND_ID}/brief/edit`);
    await expect(page.getByRole("heading", { name: /edit round brief/i })).toBeVisible({ timeout: 5000 });

    await page.locator("section", { hasText: /^Briefer/ }).locator("label", { hasText: /^Phone$/i }).locator("xpath=..").locator("input").fill("07700 900123");
    await shot(page, "16-cosmetic-edit-form");
    await page.getByRole("button", { name: /save brief/i }).click();
    await expect(page.getByText(/material change detected/i)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/rounds/${ROUND_ID}/brief`), { timeout: 5000 });

    const preservedRound = await page.evaluate(async (roundId) => {
      const res = await fetch(`/api/rounds/${roundId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("bcc_access_token")}` },
      });
      return res.json();
    }, ROUND_ID) as { teams: Array<{ pilots: Array<{ signToFly: boolean }> }> };
    expect(preservedRound.teams[0].pilots.every((slot) => slot.signToFly === true)).toBe(true);
    await page.goto(`/rounds/${ROUND_ID}/manage`);
    await expect(page.getByRole("heading", { name: /milk hill/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "17-cosmetic-signatures-preserved");
  });

  test("coord override sign records coord-override signature", async ({ page }) => {
    await login(page, "coord@example.test", PASSWORD, { skipGate: true });
    await page.goto(`/rounds/${ROUND_ID}/manage`);
    await expect(page.getByRole("button", { name: /override sign/i }).first()).toBeVisible({ timeout: 5000 });
    await shot(page, "18-override-button");
    await page.getByRole("button", { name: /override sign/i }).first().click();

    await expect(page.getByRole("dialog", { name: /override sign/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole("dialog", { name: /override sign/i }).locator("textarea").fill("Pilot confirmed by radio and cannot access the app today.");
    await shot(page, "19-override-reason");
    await page.getByRole("button", { name: /submit override/i }).click();

    await expect(page.getByText(/override signature recorded/i)).toBeVisible({ timeout: 5000 });
    const signatures = await page.evaluate(async (roundId) => {
      const res = await fetch(`/api/rounds/${roundId}/signatures`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("bcc_access_token")}` },
      });
      return res.json();
    }, ROUND_ID) as Array<{ source: string }>;
    expect(signatures.some((signature) => signature.source === "coord-override")).toBe(true);
    await shot(page, "20-override-success");
  });

  test("round complete: admin completes locked round and league blob is recomputed", async ({ page }) => {
    await login(page, "admin@example.test", PASSWORD, { skipGate: true, status: "Locked" });
    await page.goto(`/rounds/${ROUND_ID}/manage`);
    await expect(page.getByRole("button", { name: /complete round/i })).toBeVisible({ timeout: 5000 });
    await shot(page, "21-before-complete");
    await page.getByRole("button", { name: /complete round/i }).click();

    await expect(page.getByText(/complete/i)).toBeVisible({ timeout: 5000 });
    const season = await page.evaluate(async (year) => {
      const res = await fetch(`/blob/seasons/${year}.json`);
      return res.json();
    }, YEAR) as { recomputed: boolean };
    expect(season.recomputed).toBe(true);
    await shot(page, "22-round-complete");
  });
});

async function login(
  page: Page,
  email: string,
  password: string,
  opts: { skipGate?: boolean; status?: string; signedSlots?: number[] } = {},
) {
  await page.goto("/login");
  await page.evaluate(async ({ status, signedSlots, skipGate }) => {
    window.localStorage.clear();
    if (skipGate) {
      window.localStorage.setItem("bcc_first_login_dismissed_until", String(Date.now() + 86_400_000));
    }
    await fetch("/api/__e2e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status ?? "BriefComplete", signedSlots: signedSlots ?? [] }),
    });
  }, opts);
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible({ timeout: 5000 });
  await page.getByLabel(/email address/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

async function mockBackend(page: Page, state: E2EState) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;

    if (pathname.startsWith("/blob/")) {
      return fulfillJson(route, publicBlob(pathname.replace(/^\/blob\//, ""), state));
    }

    if (!pathname.startsWith("/api/")) {
      return route.continue();
    }

    try {
      await handleApi(route, pathname.replace(/^\/api\//, ""), url, state);
    } catch (error) {
      await fulfillJson(route, { error: error instanceof Error ? error.message : "Mock error", code: "MOCK_ERROR" }, 500);
    }
  });
}

async function handleApi(route: Route, apiPath: string, url: URL, state: E2EState) {
  const request = route.request();
  const method = request.method();

  if (apiPath === "__e2e" && method === "POST") {
    const body = request.postDataJSON() as { status?: string; signedSlots?: number[] };
    applyScenarioState(state, body.status ?? "BriefComplete", body.signedSlots ?? []);
    return fulfillJson(route, { ok: true });
  }
  if (apiPath === "auth/register" && method === "POST") {
    const body = request.postDataJSON() as { email?: string };
    state.lastRegisteredEmail = body.email ?? null;
    return fulfillJson(route, { status: "accepted" }, 202);
  }
  if (apiPath.startsWith("auth/verify") && method === "GET") {
    return fulfillJson(route, { success: true });
  }
  if (apiPath === "auth/login" && method === "POST") {
    const body = request.postDataJSON() as { email: string };
    const identity = state.identities[body.email.toLowerCase()];
    if (!identity) return fulfillJson(route, { error: "Invalid email or password", code: "UNAUTHORIZED" }, 401);
    const token = jwt(`access-${identity.userId}`);
    state.issuedTokens[token] = identity.email;
    return fulfillJson(route, { accessToken: token, refreshToken: jwt(`refresh-${identity.userId}`), expiresIn: 3600 });
  }
  if (apiPath === "me" && method === "GET") {
    return fulfillJson(route, currentIdentity(route, state));
  }
  if ((apiPath === `pilots/${PILOT_A_ID}` || apiPath === `api/pilots/${PILOT_A_ID}`) && method === "GET") {
    return fulfillJson(route, pilotProfile(PILOT_A_ID, "Pilot", "A"));
  }
  if ((apiPath === `pilots/${PILOT_A_ID}` || apiPath === `api/pilots/${PILOT_A_ID}`) && method === "PUT") {
    return fulfillJson(route, pilotProfile(PILOT_A_ID, "Pilot", "A"));
  }
  if (apiPath === "auth/refresh" && method === "POST") {
    return fulfillJson(route, { accessToken: jwt("refresh-access"), expiresIn: 3600 });
  }
  if (apiPath === "sign-to-fly/wording/active" && method === "GET") {
    return fulfillJson(route, state.wording);
  }
  if (apiPath === `rounds/${ROUND_ID}` && method === "GET") {
    return fulfillJson(route, state.round);
  }
  if (apiPath === `rounds/${ROUND_ID}/brief` && method === "GET") {
    if (request.headers()["referer"]?.includes(`/rounds/${ROUND_ID}/sign/${TEAM_ID}/2`)) {
      return fulfillJson(route, { error: "This slot is not yours", code: "NOT_YOUR_SLOT" }, 403);
    }
    if (state.round.status !== "BriefComplete" && state.round.status !== "Locked" && state.round.status !== "Complete") {
      return fulfillJson(route, {
        error: "This round is not yet ready for sign-to-fly.",
        code: "INVALID_STATE",
        detail: state.round.status,
      }, 409);
    }
    return fulfillJson(route, state.brief);
  }
  if (apiPath.startsWith(`rounds/${ROUND_ID}/brief/images/`) && method === "GET") {
    return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("") });
  }
  if (apiPath === `rounds/${ROUND_ID}/brief` && method === "PUT") {
    const body = request.postDataJSON() as Record<string, unknown>;
    const dryRun = url.searchParams.get("dryRun") === "true";
    const materialChanged = body.NOTAMs !== state.brief.NOTAMs;
    const invalidatedSignatureCount = materialChanged ? signedSlots(state).length : 0;
    if (dryRun) {
      return fulfillJson(route, { brief: body, materialChanged, invalidatedSignatureCount });
    }
    state.brief = { ...body, version: materialChanged ? state.brief.version + 1 : state.brief.version };
    if (materialChanged) {
      state.round.teams[0].pilots.forEach((slot: PilotSlot) => { slot.signToFly = false; });
      state.signatures = [];
    }
    return fulfillJson(route, { brief: state.brief, materialChanged, invalidatedSignatureCount });
  }
  if (apiPath === `rounds/${ROUND_ID}/lock` && method === "POST") {
    state.round.status = "Locked";
    state.round.isLocked = true;
    state.pdfGenerated = true;
    state.pureTrackMocked = true;
    return fulfillJson(route, state.round);
  }
  if (apiPath === `rounds/${ROUND_ID}/complete` && method === "POST") {
    state.round.status = "Complete";
    state.round.isLocked = true;
    state.leagueRecomputed = true;
    return fulfillJson(route, state.round);
  }
  if (apiPath === `rounds/${ROUND_ID}/signatures` && method === "GET") {
    return fulfillJson(route, state.signatures);
  }

  const signMatch = apiPath.match(/^rounds\/([^/]+)\/teams\/([^/]+)\/pilots\/(\d+)\/sign$/);
  if (signMatch && method === "POST") {
    const place = Number(signMatch[3]);
    const identity = currentIdentity(route, state);
    const slot = state.round.teams[0].pilots.find((candidate: PilotSlot) => candidate.placeInTeam === place) as PilotSlot | undefined;
    if (state.round.status !== "BriefComplete") {
      return fulfillJson(route, { error: "Round not ready", code: "INVALID_STATE", detail: state.round.status }, 409);
    }
    if (!slot || slot.pilotId !== identity.pilotId) {
      return fulfillJson(route, { error: "This slot is not yours", code: "NOT_YOUR_SLOT" }, 403);
    }
    slot.signToFly = true;
    const signature = signatureFor(slot, identity, "pilot-self");
    state.signatures.push(signature);
    return fulfillJson(route, {
      signedAt: signature.signedAt,
      briefVersion: signature.briefVersion,
      wordingVersion: signature.wordingVersion,
    });
  }

  const overrideMatch = apiPath.match(/^rounds\/([^/]+)\/teams\/([^/]+)\/pilots\/(\d+)\/sign-override$/);
  if (overrideMatch && method === "POST") {
    const place = Number(overrideMatch[3]);
    const identity = currentIdentity(route, state);
    const slot = state.round.teams[0].pilots.find((candidate: PilotSlot) => candidate.placeInTeam === place) as PilotSlot;
    slot.signToFly = true;
    const signature = signatureFor(slot, identity, "coord-override");
    state.signatures.push(signature);
    return fulfillJson(route, signature, 201);
  }

  return fulfillJson(route, { error: `Unhandled mock route: ${method} ${apiPath}`, code: "NOT_FOUND" }, 404);
}

function createState(): E2EState {
  const pilots = [slot(1, PILOT_A_ID, false), slot(2, PILOT_B_ID, false)];
  return {
    identities: {
      "pilot-a@example.test": {
        userId: "user-pilot-a",
        email: "pilot-a@example.test",
        roles: ["Pilot"],
        pilotId: PILOT_A_ID,
        clubId: CLUB_ID,
        firstLoginOfSeason: true,
        activeSeasonYear: YEAR,
      },
      "pilot-b@example.test": {
        userId: "user-pilot-b",
        email: "pilot-b@example.test",
        roles: ["Pilot"],
        pilotId: PILOT_B_ID,
        clubId: CLUB_ID,
        activeSeasonYear: YEAR,
      },
      "admin@example.test": {
        userId: ADMIN_ID,
        email: "admin@example.test",
        roles: ["Admin"],
        pilotId: null,
        clubId: null,
        activeSeasonYear: YEAR,
      },
      "coord@example.test": {
        userId: COORD_ID,
        email: "coord@example.test",
        roles: ["RoundsCoord"],
        pilotId: null,
        clubId: CLUB_ID,
        activeSeasonYear: YEAR,
      },
    },
    round: {
      id: ROUND_ID,
      date: `${YEAR}-06-09`,
      status: "BriefComplete",
      isLocked: false,
      maxTeams: 8,
      minimumScore: 0,
      briefingTime: "10:00",
      checkInByTime: "19:00",
      landByTime: "18:00",
      site: { id: "site-milk-hill", name: "Milk Hill", parkingW3W: "filled.count.soap", takeOffW3W: "pilot.launch.here" },
      organisingClub: { id: CLUB_ID, name: "Alpha Club" },
      season: { year: YEAR },
      teams: [{ id: TEAM_ID, teamName: "Alpha A", club: { id: CLUB_ID, name: "Alpha Club" }, score: 0, captainPilotId: PILOT_A_ID, pilots }],
    },
    brief: {
      roundId: ROUND_ID,
      version: 1,
      generatedAt: new Date().toISOString(),
      date: `${YEAR}-06-09`,
      siteName: "Milk Hill",
      briefingTime: "10:00",
      landByTime: "18:00",
      checkInByTime: "19:00",
      windSpeedDirection: "SW 10-15",
      directionOfFlight: "North ridge",
      expectedLandingArea: "Main bottom landing field",
      airspaceAndHazards: "Avoid the village and power lines",
      NOTAMs: "No active NOTAMs",
      BENO_LineDescription: "Standard BENO line",
      briefersNotes: "Fly safely",
      frequencyMhz: 144.450,
      takeOffW3W: "pilot.launch.here",
      briefingW3W: "briefing.point.here",
      parkingW3W: "filled.count.soap",
      briefer: { name: "Chief Briefer", phoneNumber: "07700 900000", bhpaCoachLevel: "Coach", bhpaNumber: "BHPA1", emailAddress: "brief@example.test" },
      teams: [{
        teamName: "Alpha A",
        clubName: "Alpha Club",
        pilots: [briefPilot(PILOT_A_ID, 1, "Pilot A"), briefPilot(PILOT_B_ID, 2, "Pilot B")],
      }],
      imagePaths: ["weather-chart.png", "airspace-map.png"],
    },
    wording: {
      version: 1,
      hash: "mock-wording-hash",
      html: "<h2>Legal acceptance text</h2><p>You confirm you have read the safety briefing and accept responsibility for your flight.</p>",
      plainText: "Legal acceptance text",
      createdAt: new Date().toISOString(),
      createdBy: "e2e",
    },
    signatures: [],
    lastRegisteredEmail: null,
    issuedTokens: {},
    pureTrackMocked: false,
    pdfGenerated: false,
    leagueRecomputed: false,
  };
}

function applyScenarioState(state: E2EState, status: string, signedSlotPlaces: number[]) {
  state.round.status = status;
  state.round.isLocked = status === "Locked" || status === "Complete";
  state.signatures = [];
  state.round.teams[0].pilots.forEach((candidate: PilotSlot) => {
    candidate.signToFly = signedSlotPlaces.includes(candidate.placeInTeam);
    if (candidate.signToFly) {
      state.signatures.push(signatureFor(candidate, state.identities["pilot-a@example.test"], "pilot-self"));
    }
  });
}

function publicBlob(blobPath: string, state: E2EState) {
  if (blobPath === "pilots.json") {
    return [
      { id: PILOT_A_ID, name: "Pilot A", clubId: CLUB_ID, rating: "Pilot" },
      { id: PILOT_B_ID, name: "Pilot B", clubId: CLUB_ID, rating: "Pilot" },
    ];
  }
  if (blobPath === "clubs.json") return [{ id: CLUB_ID, name: "Alpha Club" }];
  if (blobPath === "rounds.json") return [{ id: ROUND_ID, date: state.round.date, siteId: state.round.site.id, siteName: state.round.site.name, status: state.round.status, seasonYear: YEAR }];
  if (blobPath === "seasons.json") return [{ year: YEAR, active: true }];
  if (blobPath === `seasons/${YEAR}.json`) return { year: YEAR, recomputed: state.leagueRecomputed, leagueTable: [] };
  return { error: `Unhandled blob ${blobPath}` };
}

function currentIdentity(route: Route, state: E2EState): Identity {
  const token = route.request().headers()["authorization"]?.replace(/^Bearer\s+/i, "") ?? "";
  const email = state.issuedTokens[token] ?? "pilot-a@example.test";
  return state.identities[email];
}

function slot(placeInTeam: number, pilotId: string, signToFly: boolean): PilotSlot {
  return {
    placeInTeam,
    pilotId,
    status: "Filled",
    isScoring: true,
    accountedFor: false,
    signToFly,
    noScore: false,
    pilotPoints: 0,
    snapshot: null,
    flight: null,
  };
}

function briefPilot(pilotId: string, placeInTeam: number, name: string) {
  return {
    pilotId,
    placeInTeam,
    name,
    isScoring: true,
    bhpaNumber: "BHPA123",
    snapshot: {
      pilotRating: "Pilot",
      wingClass: "EN B",
      wingModel: "Mock Wing",
      wingColours: "Blue",
      helmetColour: "White",
      emergencyContactName: "Emergency Contact",
      emergencyPhoneNumber: "07700 900999",
      medicalInfo: null,
    },
  };
}

function pilotProfile(id: string, firstName: string, lastName: string) {
  return {
    id,
    coachType: "None",
    pilotRating: "Pilot",
    wingClass: "EN B",
    person: { id: `person-${id}`, firstName, lastName, fullName: `${firstName} ${lastName}`, phoneNumber: "07700 900000" },
    currentClub: { id: CLUB_ID, name: "Alpha Club" },
    seasonClubs: [{ seasonYear: YEAR, clubId: CLUB_ID, clubName: "Alpha Club" }],
    userId: `user-${id}`,
    emergencyContactName: "Emergency Contact",
    emergencyPhoneNumber: "07700 900999",
    medicalInfo: "",
    helmetColour: "White",
    harnessType: "Pod",
    harnessColour: "Black",
    wingModel: "Mock Wing",
    wingColours: "Blue",
  };
}

function signedSlots(state: E2EState) {
  return state.round.teams[0].pilots.filter((candidate: PilotSlot) => candidate.signToFly);
}

function signatureFor(slot: PilotSlot, identity: Identity, source: "pilot-self" | "coord-override") {
  return {
    id: `sig-${source}-${slot.placeInTeam}-${Date.now()}`,
    roundId: ROUND_ID,
    teamId: TEAM_ID,
    place: slot.placeInTeam,
    pilotId: slot.pilotId,
    userId: identity.userId,
    signedAt: new Date().toISOString(),
    briefVersion: statefulBriefVersion(),
    briefHash: "mock-brief-hash",
    wordingVersion: 1,
    wordingHash: "mock-wording-hash",
    ip: "127.0.0.1",
    userAgent: "playwright-e2e",
    source,
  };
}

function statefulBriefVersion() {
  return 1;
}

function jwt(subject: string) {
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `e2e.${payload}.signature`;
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
