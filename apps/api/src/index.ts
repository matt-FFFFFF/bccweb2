// Entry point — registers all Azure Functions (v4 programming model).
// Each function module registers itself via app.http() on import.

import { setup as setupTelemetry } from "./lib/telemetry.js";

// Initialise Application Insights with the PII-scrubbing telemetry processor
// BEFORE any function module imports so the redactor is registered before the
// first auto-collected request can be tracked. No-ops in local dev when
// APPLICATIONINSIGHTS_CONNECTION_STRING is unset.
setupTelemetry();

import "./functions/health.js";
import "./functions/me.js";
import "./functions/meProfile.js";

// Phase 2 — Public read endpoints
import "./functions/rounds.js";
import "./functions/seasons.js";
import "./functions/pilots.js";
import "./functions/clubs.js";
import "./functions/sites.js";
import "./functions/manufacturers.js";

// Phase 3 — Round management write endpoints
import "./functions/roundsMutate.js";
import "./functions/teams.js";
import "./functions/flights.js";
import "./functions/admin.js";

// Phase 4 — Brief + PureTrack endpoints
import "./functions/brief.js";
import "./functions/briefPdf.js";
// Sign-to-fly async reflect (queue trigger)
import "./functions/signaturesReflect.js";
import "./functions/puretrack.js";

// Phase 5 — Auth + User Management
import "./functions/authFunctions.js";
import "./functions/adminWording.js";
import "./functions/signatures.js";
import "./functions/roundRegistration.js";

// Club Teams
import "./functions/clubTeams.js";
import "./functions/seasonClubs.js";
import "./functions/pilotSeasonClubs.js";
import "./functions/igc.js";
import "./functions/manualFlight.js";
import "./functions/rescoreRound.js";
import "./functions/rescoreWorker.js";

// Phase 6 — Captain management
import "./functions/teamsCaptain.js";
