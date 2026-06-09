// Entry point — registers all Azure Functions (v4 programming model).
// Each function module registers itself via app.http() on import.

import "./functions/health.js";
import "./functions/me.js";

// Phase 2 — Public read endpoints
import "./functions/rounds.js";
import "./functions/seasons.js";
import "./functions/pilots.js";
import "./functions/clubs.js";
import "./functions/sites.js";

// Phase 3 — Round management write endpoints
import "./functions/roundsMutate.js";
import "./functions/teams.js";
import "./functions/flights.js";
import "./functions/admin.js";

// Phase 4 — Brief + PureTrack endpoints
import "./functions/brief.js";
import "./functions/puretrack.js";

// Phase 5 — Auth + User Management
import "./functions/authFunctions.js";
import "./functions/adminWording.js";

// Club Teams
import "./functions/clubTeams.js";
