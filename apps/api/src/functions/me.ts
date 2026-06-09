import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Pilot, SeasonSummary, User } from "@bccweb/types";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { getBlobClient, getPrivateBlobClient, readBlob } from "../lib/blob.js";
import { withErrorHandler } from "../lib/http.js";
import { TS_CS_VERSION } from "../lib/termsConstants.js";

async function meHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const identity = await getCallerIdentity(req);

  if (!identity) {
    return unauthorizedResponse();
  }

  let firstLoginOfSeason = false;
  let activeSeasonYear = new Date().getFullYear();

  if (identity.roles.includes("Pilot") && identity.pilotId) {
    try {
      let seasons: SeasonSummary[] = [];
      try {
        seasons = await readBlob<SeasonSummary[]>(getBlobClient("seasons.json"));
      } catch (e: unknown) {
        if ((e as { statusCode?: number }).statusCode !== 404) throw e;
      }
      
      const activeSeason = seasons.find((s) => s.active) ?? seasons[seasons.length - 1];
      if (activeSeason) {
        activeSeasonYear = activeSeason.year;
      }

       const pilot = await readBlob<Pilot>(getPrivateBlobClient(`pilots/${identity.pilotId}.json`));

       const hasSeasonClub = pilot.seasonClubs?.some((sc) => sc.seasonYear === activeSeasonYear);
       const profileUpdatedYear = pilot.profileUpdatedAt ? new Date(pilot.profileUpdatedAt).getFullYear() : 0;

       firstLoginOfSeason = !pilot.profileUpdatedAt || profileUpdatedYear < activeSeasonYear || !hasSeasonClub;
    } catch (err: unknown) {
      // Ignore not found errors for pilot or other issues, just default to false if we can't determine
    }
  }

  let tsCsAcceptanceRequired = false;
  try {
    const user = await readBlob<User>(getPrivateBlobClient(`users/${identity.userId}.json`));
    tsCsAcceptanceRequired = (user.acceptedTsCsVersion ?? 0) < TS_CS_VERSION;
  } catch {
    tsCsAcceptanceRequired = false;
  }

  return {
    status: 200,
    jsonBody: {
      ...identity,
      firstLoginOfSeason,
      activeSeasonYear,
      tsCsAcceptanceRequired,
    },
  };
}

app.http("me", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "me",
  handler: withErrorHandler(meHandler),
});
