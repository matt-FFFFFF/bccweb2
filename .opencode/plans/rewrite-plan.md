# BCCWeb Rewrite Plan

## Context

BCCWeb is a paragliding cross-country competition management system for the British Cross-Country (BCC) league. The current app is an ASP.NET MVC (.NET Framework) application backed by Azure SQL Server, hosted on Azure App Service (Windows). The goal is to rewrite it as a cost-optimised modern architecture with **cost as the primary constraint**.

**Existing app location:** `./_current` (symlink)

---

## Proposed Architecture

```
Azure Static Web Apps (Free tier)
  ├── React + TypeScript SPA
  └── Auth handled by self-hosted Functions (no external identity provider)

Azure Functions (Consumption plan, TypeScript/Node.js)
  ├── Mounted at /api/* by SWA
  └── Owns the full auth surface: register, login, verify, reset

Azure Blob Storage (General Purpose v2, LRS)
  └── All application data as JSON + generated PDFs (incl. auth credentials)

Azure Communication Services — Email (pay-per-email)
  └── Transactional email (round brief, notifications, email verify, password reset)
  └── Custom sender domain (DKIM/SPF/DMARC via 3 DNS records)

PureTrack API (existing)
  └── Flight tracking group management
```

### Estimated Monthly Cost (production)

| Service | SKU | Cost |
|---------|-----|------|
| Static Web Apps | Free | $0 |
| Functions | Consumption (Y1) | ~$0 |
| Blob Storage | GPv2 LRS | ~$0.10–0.50 |
| Auth | Self-hosted in Functions | $0 |
| ACS Email | Pay-per-email ($0.00025/email, 100/day free) | ~$0 |
| **Total** | | **~$1–2/month** |

vs. current ~$15–50/month (Azure SQL S0/S1 + App Service B1/S1).

---

## Viability Assessment

### Why This Works

- **Write volume is very low** — weekly rounds at most, ~50–100 pilots per season. Blob lease contention is essentially impossible at this scale.
- **Most data is public and read-only** — results, league tables, round details, pilot profiles. Perfect for a static SPA reading blobs directly.
- **Data is naturally append-oriented** — once a round is complete its data is frozen. Seasons accumulate rounds. This maps well to JSON blob documents.
- **Existing "locking" metaphor maps to blob leases** — the app already has a `isLocked` concept on rounds; Azure Blob Lease provides the same mutex semantics.

### Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Multi-blob consistency (completing a round updates multiple blobs) | Sequential writes; derived blobs recomputed via `POST /api/admin/rounds/{id}/recompute`. Primary blob always written first. |
| Puppeteer cold start in consumption plan | Use `chrome-aws-lambda` (optimised for serverless); accept occasional ~10s delay on round-lock (rare operation). |
| Blob lease contention | Retry with exponential backoff. Negligible risk at this scale. |
| Auth credential security | bcrypt (cost 12) for passwords; short-lived SHA-256–hashed tokens for verify/reset; JWT_SECRET stored as encrypted app setting |
| Scoring complexity | Port existing C# wing-factor/scoring logic directly to TypeScript; unit-test thoroughly. |

---

## Authentication

### Self-Hosted Auth (Azure Functions + Blob + ACS Email)

Azure AD B2C is closed to new customers (deprecated May 2025). Auth is implemented entirely within the existing stack — no external identity provider.

**Auth surface owned by Functions:**
- **Registration** — email + password, triggers email verification via ACS Email
- **Login** — email + password → issues JWT access token + refresh token
- **Email verification** — short-lived token sent by ACS Email, validated by Function
- **Password reset** — short-lived token sent by ACS Email, validated by Function
- **Token refresh** — stateless refresh JWT → new access token

**SWA integration** — no built-in SWA auth used. `staticwebapp.config.json` has no `auth` block. The frontend manages tokens in `localStorage` and attaches `Authorization: Bearer <access-token>` to every API call.

### Tokens

JWTs are signed with **HS256** using `JWT_SECRET` (an app setting — a random 256-bit secret, generated once and stored in Azure Functions application settings / Terraform `azurerm_linux_function_app` `app_settings`).

| Token | Lifetime | Storage |
|-------|----------|---------|
| Access token | 1 hour | `localStorage` |
| Refresh token | 30 days | `localStorage` |

Both are stateless JWTs. The `sub` claim is the user's UUID (stable identity, replaces B2C `oid`).

```typescript
// Access token payload
{ sub: "user-uuid", email: "jane@example.com", type: "access", iat, exp }

// Refresh token payload
{ sub: "user-uuid", type: "refresh", iat, exp }
```

### Auth Credential Storage

```
data/
  auth/
    {user-id}.json      # { passwordHash, emailVerified, createdAt }
    tokens/
      {token-sha256}.json   # Short-lived tokens for verify/reset
                            # { userId, type: "verify"|"reset", expiresAt }
```

Passwords are hashed with **bcrypt** (cost factor 12). Short-lived tokens (email verify, password reset) are generated as `crypto.randomBytes(32)`, stored as their SHA-256 hash, and expire after 24 h (verify) or 1 h (reset). The token is deleted from blob on first use.

### Role Management

Identical to original design — roles live in blob, not in any identity provider:

```
data/users/{user-id}.json
```

```jsonc
{
  "id": "user-uuid",
  "email": "jane@example.com",
  "roles": ["RoundsCoord"],   // Admin | RoundsCoord | Pilot
  "pilotId": "pilot-uuid",   // null until linked
  "clubId": "club-uuid"      // null until linked
}
```

Admin manages roles via the admin UI → Function → blob write.

### Registration Flow

`POST /api/auth/register { email, password }`

1. Validate input (email format, password min-length 8)
2. Check `user-index.json` — reject if email already registered
3. Hash password with bcrypt (cost 12)
4. Generate UUID for user
5. Write `auth/{uuid}.json` `{ passwordHash, emailVerified: false, createdAt }`
6. Write `users/{uuid}.json` with pilot auto-link (see below)
7. Update `user-index.json` (email → uuid)
 8. Generate verification token → store `auth/tokens/{sha256}.json` (24 h TTL)
 9. Send verification email via ACS Email
10. Return `201 Created` (no tokens issued yet — email must be verified first)

`GET /api/auth/verify?token={raw-token}`

1. SHA-256 hash the token → load `auth/tokens/{hash}.json`
2. Check `type === "verify"` and `expiresAt` not passed
3. Set `auth/{userId}.json` `emailVerified = true`
4. Delete token blob
5. Issue access + refresh tokens → redirect to frontend with tokens in query string (or return JSON for SPA to handle)

### Login Flow

`POST /api/auth/login { email, password }`

1. Look up email in `user-index.json` → get userId
2. Load `auth/{userId}.json`
3. `bcrypt.compare(password, passwordHash)` — constant-time
4. Reject if `emailVerified === false` (prompt to resend verification)
5. Issue access token (1 h) + refresh token (30 days)
6. Return `{ accessToken, refreshToken, expiresIn: 3600 }`

### Password Reset Flow

`POST /api/auth/forgot-password { email }`

1. Look up email (silently succeed even if not found — don't leak existence)
2. Generate reset token → store `auth/tokens/{sha256}.json` (1 h TTL)
3. Send reset email via ACS Email

`POST /api/auth/reset-password { token, newPassword }`

1. SHA-256 hash token → load token blob
2. Check `type === "reset"` and not expired
3. Hash new password, update `auth/{userId}.json`
4. Delete token blob
5. Return `200 OK`

### Token Refresh

`POST /api/auth/refresh { refreshToken }`

1. Verify refresh JWT with `JWT_SECRET`, check `type === "refresh"`
2. Load `users/{sub}.json` to confirm user still exists
3. Issue new access token (1 h)
4. Return `{ accessToken, expiresIn: 3600 }`

### Auth Middleware (Functions)

```typescript
async function getCallerIdentity(req: HttpRequest): Promise<CallerIdentity | null> {
  // 1. Extract Authorization: Bearer <jwt> header
  // 2. Verify JWT with JWT_SECRET (HS256), check type === "access"
  // 3. Read data/users/{sub}.json from blob
  // 4. Return { userId, email, roles, pilotId, clubId }
}
```

Simpler than the original B2C JWKS approach — no HTTP fetch to a metadata endpoint, no key rotation to handle.

### User Registration & Pilot Linking (Fully Implicit)

Unchanged from original design — pilot auto-linking happens at registration time using the same email-match logic:

```typescript
async function buildUserRecord(userId: string, email: string): Promise<User> {
  const pilotIndex = await readBlob<PilotSummary[]>(getBlobClient('pilots.json'));
  const match = pilotIndex.find(p => p.email?.toLowerCase() === email.toLowerCase());

  return {
    id: userId,
    email,
    roles: match ? ['Pilot'] : [],
    pilotId: match?.id ?? null,
    clubId: match?.clubId ?? null,
    createdAt: new Date().toISOString()
  };
}
```

**Migration prerequisite:** each pilot record must include their email address (sourced from the existing `AspNetUser.Email` during SQL migration).

**Edge cases:**
- Pilot registers with a different email than their record → lands as unlinked; admin assigns `pilotId` via admin UI
- New pilot with no pre-existing record → lands as unlinked; admin creates pilot record then sets `pilotId` directly

---

## Blob Storage Schema

### Directory Structure

```
data/
  config.json                    # Wing factors, team/pilot limits, scoring rules
  user-index.json                # { "email@example.com": "user-uuid" }  (email lookup)
  auth/
    {user-id}.json               # { passwordHash, emailVerified, createdAt }
    tokens/
      {token-sha256}.json        # Short-lived tokens: { userId, type, expiresAt }
  users/
    {user-id}.json               # User record: roles, pilotId, clubId
  pilots.json                    # Index: [{id, name, bhpaNumber, clubId, rating, userId}]
  pilots/
    {uuid}.json                  # Full pilot record
  clubs.json                     # [{id, name}]
  clubs/
    {uuid}.json                  # Club detail (sites list, teams list)
  manufacturers.json             # [{id, name}]
  pilot-ratings.json             # [{id, description}]  e.g. Club Pilot, Pilot, Advanced Pilot
  sites.json                     # [{id, name, status, clubId}]
  sites/
    {uuid}.json                  # Site detail (W3W coords, guide URL, contact)
  seasons.json                   # [{id, year, active}]
  seasons/
    {year}.json                  # Season: rounds list + pre-computed league table
  rounds.json                    # [{id, date, siteId, siteName, status, seasonYear}]
  rounds/
    {uuid}.json                  # Full round document (see schema below)
  round-briefs/
    {round-uuid}.json            # Round brief source data
    {round-uuid}.pdf             # Generated PDF
  results/
    {season-year}.json           # Pre-computed per-round results for display
```

### Round Document (primary working document)

The round document stores per-round operational data. Pilot slots store only a `pilotId` reference until the round is locked, at which point a **safety/scoring snapshot** is frozen. Non-critical pilot details (name, BHPA number, PureTrack info, etc.) are read from `pilots/{uuid}.json` on demand and never stored in the round.

**Snapshot fields** (frozen at lock time — must be point-in-time correct):

| Field | Reason |
|-------|--------|
| `wingClass` | Scoring — wing factor applied to flight distance |
| `pilotRating` | Result categorisation (CP / P / AP) |
| `phoneNumber` | Safety/accountability on the day |
| `helmetColour`, `harnessType`, `harnessColour` | Field identification (safety) |
| `wingManufacturer`, `wingModel`, `wingColours` | Field identification (safety) |
| `emergencyContactName`, `emergencyPhoneNumber` | Safety document — must reflect day-of details |
| `medicalInfo` | Safety |

**Not stored in round** (read from `pilots/{uuid}.json` when needed):
- Name, BHPA number, PureTrack ID/link, coach type, current club

```jsonc
{
  "id": "uuid",
  "legacyId": 42,               // original SQL int ID, for migration reference
  "date": "2025-07-12",
  "status": "Complete",         // Proposed | Confirmed | BriefComplete | Locked | Complete | Cancelled
  "isLocked": false,
  "maxTeams": 8,
  "minimumScore": 0,
  "briefingTime": "10:00",
  "landByTime": "18:00",
  "checkInByTime": "09:30",
  "narrative": "...",
  "pureTrackGroupId": 12345,
  "pureTrackGroupName": "BCC Hay Bluff Sat 12 Jul 25",
  "pureTrackGroupSlug": "bcc-hay-bluff-sat-12-jul-25",
  "site": { "id": "uuid", "name": "Hay Bluff", "parkingW3W": "...", "briefingW3W": "...", "takeOffW3W": "..." },
  "organisingClub": { "id": "uuid", "name": "Advance" },
  "season": { "year": 2025 },
  "teams": [
    {
      "id": "uuid",
      "teamName": "Advance A",
      "club": { "id": "uuid", "name": "Advance" },
      "score": 145.2,
      "pureTrackGroupId": 12346,
      "pureTrackGroupSlug": "bcc-hay-bluff-...-advance-a",
      "pilots": [
        {
          "placeInTeam": 1,
          "isScoring": true,
          "status": "Filled",         // Empty | Filled
          "accountedFor": false,
          "signToFly": false,
          "noScore": false,
          "pilotPoints": 0,
          "pilotId": "uuid",          // reference — resolve name etc. from pilots/{uuid}.json
          "snapshot": null,           // null until round is locked; frozen at lock time
          // snapshot (post-lock): {
          //   wingClass, pilotRating, phoneNumber,
          //   helmetColour, harnessType, harnessColour,
          //   wingManufacturer, wingModel, wingColours,
          //   emergencyContactName, emergencyPhoneNumber, medicalInfo
          // }
          "flight": null              // populated when flight is logged
          // flight: { id, distance, duration, url, dateTime, scoringType, score,
          //           wingFactor, isManualLog, manualLogJustification,
          //           isFirstXC, isFirstUKXC, isUKPersonalBest, isOverallPB,
          //           awardedFirstXC, awardedFirstUKXC, awardedUKPB, awardedOverallPB }
        }
      ]
    }
  ]
}
```

**Rendering a round page** (pre-lock): fetches `rounds/{uuid}.json` + parallel reads of `pilots/{uuid}.json` for each registered pilot. At the scale of this application (~50–100 pilots/round) parallel blob reads are fast enough for admin pages; public result pages use pre-computed blobs and need no per-pilot reads at all.

### Pilot Document

```jsonc
{
  "id": "uuid",
  "legacyId": 7,
  "bhpaNumber": 12345,
  "coachType": "None",            // None | ClubCoach | SeniorCoach | Instructor | SeniorInstructor
  "pilotRating": "Pilot",
  "pureTrackId": 9876,
  "pureTrackLink": "https://puretrack.io/...",
  "helmetColour": "Red",
  "harnessType": "Pod",
  "harnessColour": "Black",
  "emergencyContactName": "John Smith",
  "emergencyPhoneNumber": "07700 900000",
  "medicalInfo": "",
  "wingClass": "EN B",
  "wingManufacturer": { "id": "uuid", "name": "Advance" },
  "wingModel": "Iota 3",
  "wingColours": "Blue/White",
  "person": {
    "id": "uuid",
    "firstName": "Jane",
    "lastName": "Smith",
    "fullName": "Jane Smith",
    "phoneNumber": "07700 900001"
  },
  "currentClub": { "id": "uuid", "name": "Advance" },
  "seasonClubs": [                // pilot's club per season
    { "seasonYear": 2025, "clubId": "uuid", "clubName": "Advance" }
  ],
  "userId": "user-uuid"          // null until self-registered and linked
}
```

### Config Document

```jsonc
{
  "maxTeamsInClub": 2,
  "maxPilotsInTeam": 12,
  "maxScoringPilotsInTeam": 6,
  "flightDateValidationEnabled": true,
  "wingFactors": {
    "EN A": 1.0,
    "EN B": 0.9,
    "EN C": 0.8,
    "EN C 2-liner": 0.7,
    "EN D": 0.6,
    "EN D 2-liner": 0.5
  }
}
```

---

## Blob Locking Strategy

Azure Blob Lease provides a 15–60 second renewable mutex on any blob. All write operations follow this pattern:

```typescript
async function withLease<T>(
  blobClient: BlobClient,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  const lease = blobClient.getBlobLeaseClient();
  const { leaseId } = await lease.acquireLease(30);
  try {
    const result = await fn(leaseId);
    await lease.releaseLease();
    return result;
  } catch (err) {
    await lease.releaseLease().catch(() => {}); // best-effort release
    throw err;
  }
}
```

**Multi-blob operations** (e.g., completing a round): Write to primary blob first, then update index/derived blobs sequentially. If a secondary write fails, the primary is still correct. A `POST /api/admin/rounds/{id}/recompute` endpoint recomputes all derived state from the primary round blob.

**Derived blobs** (pre-computed for performance):
- `seasons/{year}.json` — league table, recomputed when any round in the season completes
- `results/{year}.json` — per-round results display, recomputed on round complete
- `rounds.json` — index, updated on any round create/status change

---

## Scoring Logic

Extracted to a shared TypeScript module (`packages/scoring/src/index.ts`) used by both the Functions backend and (optionally) the frontend for preview:

```typescript
export function scoreRound(round: Round, config: Config): Round {
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (slot.flight && !slot.noScore) {
        const factor = config.wingFactors[slot.snapshot.wingClass] ?? 1.0;
        slot.flight.score = Math.round(slot.flight.distance * factor * 10) / 10;
        slot.pilotPoints = slot.flight.score;
      }
    }
    const scoringFlights = team.pilots
      .filter(p => p.isScoring && !p.noScore && p.flight?.score != null)
      .sort((a, b) => (b.flight!.score - a.flight!.score))
      .slice(0, config.maxScoringPilotsInTeam);
    team.score = Math.round(
      scoringFlights.reduce((sum, p) => sum + p.flight!.score, 0) * 10
    ) / 10;
  }
  return round;
}

export function computeLeague(
  rounds: Round[],
  config: Config
): LeagueEntry[] {
  // aggregate team scores across completed rounds, take best N
  // ...
}
```

Wing factor per wing class, applied to raw distance (km) to give a normalised score. Top `maxScoringPilotsInTeam` scores count toward team score.

---

## Functions API

All Functions are TypeScript, Node.js 20, isolated worker model.

### Auth Middleware

Every Function that requires auth runs through:

```typescript
async function getCallerIdentity(req: HttpRequest): Promise<CallerIdentity | null> {
  // 1. Extract Authorization: Bearer <jwt> header
  // 2. Verify JWT with JWT_SECRET (HS256), check type === "access"
  // 3. Read data/users/{sub}.json from blob
  // 4. Return { userId, email, roles, pilotId, clubId }
}
```

### Endpoint Reference

#### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | Public | Register with email + password; sends verification email |
| GET | `/api/auth/verify` | Public | Verify email address via token from email link |
| POST | `/api/auth/resend-verification` | Public | Resend verification email |
| POST | `/api/auth/login` | Public | Email + password → access + refresh tokens |
| POST | `/api/auth/refresh` | Public | Refresh token → new access token |
| POST | `/api/auth/forgot-password` | Public | Send password reset email |
| POST | `/api/auth/reset-password` | Public | Reset password via token |

#### Identity
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/me` | Authenticated | Current user identity + roles |

#### Rounds
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/rounds` | Public | List all rounds (`rounds.json`) |
| GET | `/api/rounds/{id}` | Public | Round detail |
| POST | `/api/rounds` | RoundsCoord | Create round |
| PUT | `/api/rounds/{id}` | RoundsCoord | Update round metadata |
| POST | `/api/rounds/{id}/confirm` | RoundsCoord | Proposed → Confirmed |
| POST | `/api/rounds/{id}/brief-complete` | RoundsCoord | Confirmed → BriefComplete |
| POST | `/api/rounds/{id}/lock` | RoundsCoord | BriefComplete → Locked + generate PDF + email |
| POST | `/api/rounds/{id}/unlock` | RoundsCoord | Locked → Confirmed |
| POST | `/api/rounds/{id}/complete` | RoundsCoord | Locked → Complete + score + recompute league |
| POST | `/api/rounds/{id}/narrative` | RoundsCoord | Update narrative |

#### Teams & Pilots in Rounds
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/rounds/{id}/teams` | RoundsCoord | Add team to round |
| DELETE | `/api/rounds/{id}/teams/{teamId}` | RoundsCoord | Remove team from round |
| POST | `/api/rounds/{id}/teams/{teamId}/pilots` | RoundsCoord/Captain | Register pilot in slot |
| DELETE | `/api/rounds/{id}/teams/{teamId}/pilots/{place}` | RoundsCoord/Captain | Remove pilot from slot |
| PUT | `/api/rounds/{id}/teams/{teamId}/pilots/{place}/accounted` | RoundsCoord | Toggle accounted-for |
| PUT | `/api/rounds/{id}/teams/{teamId}/pilots/{place}/sign-to-fly` | RoundsCoord | Toggle sign-to-fly |

#### Flights
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/rounds/{id}/flights` | Pilot/RoundsCoord | Log a flight |
| PUT | `/api/rounds/{id}/flights/{flightId}` | Pilot(own)/RoundsCoord | Update flight |
| DELETE | `/api/rounds/{id}/flights/{flightId}` | Admin/RoundsCoord | Delete flight |

#### Pilots
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/pilots` | Public | Pilot index |
| GET | `/api/pilots/{id}` | Public | Pilot detail |
| POST | `/api/pilots` | Admin | Create pilot record |
| PUT | `/api/pilots/{id}` | Pilot(own)/Admin | Update pilot profile |

#### Clubs
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/clubs` | Public | Club list |
| POST | `/api/clubs` | Admin | Create club |
| PUT | `/api/clubs/{id}` | Admin | Update club |

#### Sites
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/sites` | Public | Site list |
| POST | `/api/sites` | Admin | Create site |
| PUT | `/api/sites/{id}` | Admin | Update site |

#### Seasons & Results
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/seasons` | Public | Season list |
| GET | `/api/seasons/{year}` | Public | Season detail + league table |
| GET | `/api/seasons/{year}/results` | Public | Round-by-round results |
| POST | `/api/seasons` | Admin | Create season |

#### Admin
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/users` | Admin | List users + roles |
| PUT | `/api/admin/users/{userId}/roles` | Admin | Set user roles |
| POST | `/api/admin/rounds/{id}/recompute` | Admin | Recompute all derived blobs for a round |
| GET | `/api/admin/config` | Admin | Get config |
| PUT | `/api/admin/config` | Admin | Update config |

#### PureTrack
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/rounds/{id}/puretrack/create-groups` | RoundsCoord | Create PureTrack groups (called by lock) |

#### Round Brief
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/rounds/{id}/brief` | RoundsCoord | Get round brief data |
| GET | `/api/rounds/{id}/brief/pdf` | RoundsCoord | Download brief PDF |

---

## PDF Generation

On `POST /api/rounds/{id}/lock`:
1. Render round brief data into an HTML template (Handlebars)
2. Launch Puppeteer with `@sparticuz/chromium` inside the Function
3. `page.pdf()` → `Buffer`
4. Upload PDF to `round-briefs/{round-uuid}.pdf` in blob storage
5. Send via ACS Email (`@azure/communication-email`) with PDF as Base64 attachment

**Package:** `puppeteer-core` + `@sparticuz/chromium` (maintained fork of `chrome-aws-lambda`, optimised for AWS Lambda / Azure Functions consumption plan).

The PDF is stored in blob so it can be re-downloaded later without regeneration.

---

## Frontend Structure

React 18 + TypeScript + Vite, deployed via SWA.

```
apps/web/
  src/
    components/          # Shared UI components (Button, Table, Badge, etc.)
    pages/
      Home.tsx
      rounds/
        RoundsList.tsx           # Public
        RoundDetail.tsx          # Public (teams, flights, briefing info)
        RoundManage.tsx          # Auth-gated (team/pilot management)
        RoundBrief.tsx           # Auth-gated (round brief view)
      results/
        League.tsx               # Public (season league table)
        RoundResults.tsx         # Public (per-round results)
      pilots/
        PilotsList.tsx           # Public
        PilotProfile.tsx         # Public (own profile auth-gated for edit)
      admin/
        Clubs.tsx                # Admin
        Sites.tsx                # Admin
        Users.tsx                # Admin (role management)
        Config.tsx               # Admin
      auth/
        Login.tsx                # Email + password login form
        Register.tsx             # Registration form
        VerifyEmail.tsx          # Email verification landing page (reads ?token= from URL)
        ForgotPassword.tsx       # Request password reset email
        ResetPassword.tsx        # New password form (reads ?token= from URL)
    hooks/
      useAuth.ts                 # Reads tokens from localStorage, provides identity + logout
      useBlob.ts                 # Direct blob reads for public data
    lib/
      api.ts                     # Typed API client + auth header attachment (all /api/* calls)
      blobClient.ts              # Direct blob storage reads (public containers)
    router.tsx
    main.tsx
```

**Public data reads:** Pages that display public data (rounds list, results, league, pilot profiles) fetch directly from blob storage URLs — zero Function invocations, low latency, no auth required.

**Mutations:** All writes go through `/api/*` Functions.

---

## Repository Structure

Monorepo layout:

```
bccweb2/
  _current/                    # Existing app (symlink, reference only)
  .opencode/
    plans/
      rewrite-plan.md          # This document
  apps/
    web/                       # React + TypeScript SPA
    api/                       # Azure Functions (TypeScript)
  packages/
    scoring/                   # Shared scoring logic + types
    types/                     # Shared TypeScript types (Round, Pilot, etc.)
  iac/                         # Terraform for new architecture
  scripts/
    migrate/                   # SQL → Blob migration scripts
  .github/
    workflows/
      deploy-web.yml           # SWA deployment
      deploy-api.yml           # Functions deployment
```

---

## Data Migration

A one-time Node.js migration script (`scripts/migrate/`) that:

1. Connects to existing Azure SQL DB via `mssql` package
2. Reads all entities via SQL queries
3. Assigns UUIDs (stores original SQL int as `legacyId`)
4. Transforms to new JSON schema
5. Writes blobs to Azure Blob Storage
6. Generates all index blobs
7. Pre-computes league tables and results for all historical seasons

**Migration order** (respects foreign key dependencies):
1. `config.json`
2. Manufacturers → `manufacturers.json`
3. PilotRatings → `pilot-ratings.json`
4. Clubs → `clubs.json` + `clubs/{uuid}.json`
5. Sites → `sites.json` + `sites/{uuid}.json`
6. Seasons → `seasons.json` + `seasons/{year}.json` (partial)
7. Teams → embedded in club documents
8. People + Pilots → `pilots.json` + `pilots/{uuid}.json`
9. Rounds + RoundTeams + RoundTeamPlaces + RoundTeamPilots → `rounds.json` + `rounds/{uuid}.json`
10. Flights → embedded in round documents
11. RoundBriefs → `round-briefs/{uuid}.json`
12. Recompute: `seasons/{year}.json` (league), `results/{year}.json`

**User identity migration:** Existing pilots have no account yet. On first login post-migration, each pilot self-registers via the new auth flow and is auto-linked to their pilot record via email match. No automated migration of auth credentials is needed.

---

## Infrastructure as Code (Terraform)

Replace existing Terraform (`_current/iac/`) with new IaC (`iac/`):

**Add:**
- `azurerm_static_web_app`
- `azurerm_storage_account` (GPv2, LRS)
- `azurerm_storage_container` — `data` (private, accessed by Functions) + `$web` (managed by SWA)
- `azurerm_linux_function_app` (consumption plan, Node.js 20)
- `azurerm_service_plan` (Y1 consumption, Linux)
- `JWT_SECRET` app setting — random 256-bit secret generated once (`random_password` resource or set manually)
- `azurerm_communication_service` — ACS hub
- `azurerm_email_communication_service` — email channel attached to ACS hub
- `azurerm_email_communication_service_domain` — CustomerManaged (custom sender domain); Terraform outputs the 3 DNS records (`verification_records` attribute: SPF, DKIM, DMARC) to add at the registrar
- `ACS_CONNECTION_STRING` app setting — connection string from ACS resource, stored as encrypted Function app setting

**Remove:**
- `azurerm_mssql_server`
- `azurerm_mssql_database`
- `azurerm_windows_web_app`
- `azurerm_service_plan` (Windows B1)

**Note:** No external identity provider required. Auth is self-contained in Functions. No B2C tenant, no Azure AD configuration.

---

## Round Workflow (State Machine)

```
Proposed → Confirmed → BriefComplete → Locked → Complete
                                            ↕ (unlock)
                                        Confirmed
```

**On Lock:**
1. Acquire lease on `rounds/{uuid}.json`
2. Set `status = Locked`, `isLocked = true`
3. Set all pilots to `accountedFor = false`
4. Release lease
5. Call PureTrack API: create round group + per-team groups, add pilots
6. Generate round brief PDF (Puppeteer)
 7. Upload PDF to `round-briefs/{uuid}.pdf`
 8. Send email via ACS Email (`@azure/communication-email`) with PDF as Base64 attachment
 9. Update `round-briefs/{uuid}.json` with brief data

**On Complete:**
1. Acquire lease on `rounds/{uuid}.json`
2. Run `scoreRound()` — compute pilot scores and team scores
3. Set `status = Complete`, `isLocked = false`
4. Release lease
5. Recompute `seasons/{year}.json` (league table)
6. Recompute `results/{year}.json`
7. Update `rounds.json` index

---

## Implementation Phases

### Phase 1 — Foundation ✅ COMPLETE

- [x] Monorepo scaffold (npm workspaces: `apps/*`, `packages/*`)
- [x] Shared TypeScript types package (`packages/types`)
- [x] Shared scoring logic package (`packages/scoring`) — 16 unit tests, all passing
- [x] Azure Functions v4 scaffold (TypeScript, Node.js 20, isolated worker)
- [x] Auth middleware (`apps/api/src/lib/auth.ts`): HS256 JWT validation via `jsonwebtoken` + `JWT_SECRET`; user record auto-creation with email-based pilot linking
- [x] Blob client utilities (`readBlob`, `writeBlob`, `withLease`)
- [x] `GET /api/health` and `GET /api/me` Functions
- [x] React 18 + Vite SPA scaffold
- [x] `useAuth` hook: localStorage JWT management; `login()`, `logout()`, token refresh on init
- [x] `staticwebapp.config.json`: SPA fallback, `/admin/*` route guard, security headers (no external auth provider)
- [x] Terraform IaC: Storage GPv2 LRS, Functions Y1, SWA Free, `JWT_SECRET` app setting
- [x] `deploy-web.yml` — SWA deployment on push to main
- [x] `deploy-api.yml` — Functions deployment on push to main
- [x] `docker-compose.yml` — Azurite local emulator + `node:20-alpine` init container

**Local dev notes:**
- Azurite init uses hand-rolled Shared Key HMAC (no azure-cli): path-style canonical resource is `/<account>/<account>/<container>` (account doubled)
- `deploy-api.yml` deployment package: build → `npm prune --omit=dev` → `rsync -a --copy-links node_modules/` to dereference workspace symlinks for `@bccweb/types` and `@bccweb/scoring`
- `WEBSITE_RUN_FROM_PACKAGE=1` set in Terraform; zip is uploaded via Kudu by `azure/functions-action@v1`
- Two GitHub secrets required: `AZURE_FUNCTIONAPP_NAME`, `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`
- `apps/api/local.settings.json` requires `JWT_SECRET` (any random string locally) for auth Function testing

### Phase 2 — Public Read Pages ✅ COMPLETE
- [x] Migration script: SQL → Blob (all entities)
- [x] `GET /api/rounds`, `GET /api/rounds/{id}` Functions
- [x] `GET /api/seasons/{year}` + league Functions
- [x] `GET /api/pilots`, `GET /api/pilots/{id}` Functions
- [x] Frontend: Home, Rounds list, Round detail, League, Results, Pilot profiles
- [x] Direct blob reads for public data (no Function hop)

**Phase 2 implementation notes:**
- API Functions: `rounds.ts`, `seasons.ts`, `pilots.ts`, `clubs.ts`, `sites.ts` — all public GET endpoints
- Frontend pages: `Home`, `RoundsList`, `RoundDetail`, `League`, `RoundResults`, `PilotsList`, `PilotProfile`
- `blobClient.ts` + `useBlob.ts` hook for direct public blob reads (zero Function hops for read-only public pages)
- `StatusBadge`, `LoadingSpinner`/`ErrorMessage` shared components
- `router.tsx` updated with all Phase 2 routes + `ResultsRedirect` (→ active season year)
- `vite.config.ts`: `/blob` proxy → Azurite (`/devstoreaccount1/data`) for local dev
- `scripts/init-storage.mjs`: `data` container created with `x-ms-blob-public-access: blob`
- `docker-compose.yml`: Azurite `--blobCors` flag for local SPA origin (`localhost:5173`)
- `iac/storage.tf`: `allow_nested_items_to_be_public = true`, container `container_access_type = "blob"`, CORS rule
- `scripts/migrate/migrate.mjs`: Full SQL → Blob migration (all 10 steps, scoring applied to Complete rounds)

### Phase 3 — Round Management ✅ COMPLETE
- [x] `POST /api/rounds` + Create round form
- [x] Round status workflow Functions (confirm, brief-complete, lock, unlock, complete)
- [x] `POST/DELETE /api/rounds/{id}/teams` — team registration
- [x] `POST/DELETE /api/rounds/{id}/teams/{teamId}/pilots` — pilot registration
- [x] Accounted-for / sign-to-fly toggles
- [x] `POST /api/rounds/{id}/flights` — flight logging
- [x] `PUT/DELETE /api/rounds/{id}/flights/{id}` — flight management
- [x] Scoring: `scoreRound()` called on complete
- [x] League table recomputation

**Phase 3 implementation notes:**
- `apps/api/src/lib/recompute.ts`: `updateRoundsIndex(round)` + `recomputeSeason(year)` + `buildSeasonResults()` — loads all round docs in parallel, computes league via `computeLeague()`, resolves pilot names from `pilots.json`, writes `seasons/{year}.json` and `results/{year}.json`
- `apps/api/src/functions/roundsMutate.ts`: All round write endpoints — create, update metadata, confirm, brief-complete, lock (with parallel pilot snapshot load outside the lease), unlock, complete (scores round then fires `recomputeSeason()` async best-effort), narrative
- `apps/api/src/functions/teams.ts`: Team CRUD + pilot slot management (add/remove team, add/remove pilot, accounted-for, sign-to-fly) — all mutations use `mutateLocked()` helper
- `apps/api/src/functions/flights.ts`: Log / update / delete flights — Pilot can log own flight; Admin/RoundsCoord can delete any flight; update pre-reads to check ownership
- `apps/api/src/functions/admin.ts`: `POST /api/admin/rounds/{id}/recompute` + `GET/PUT /api/admin/config`
- `apps/api/src/index.ts`: Phase 3 module imports added (`roundsMutate.js`, `teams.js`, `flights.js`, `admin.js`)
- `apps/web/src/pages/rounds/CreateRound.tsx`: Create round form — date, site dropdown, season dropdown, maxTeams, minimumScore, briefing/check-in/land-by times; redirects to `/rounds/${id}/manage` on success
- `apps/web/src/pages/rounds/RoundManage.tsx`: Full management page — status workflow buttons, metadata edit, narrative edit, team/pilot management, accounted-for/sign-to-fly toggles, inline flight log/edit forms; mutations via `runAction()` which reloads round via API
- `apps/web/src/router.tsx`: Added `/rounds/new` → `CreateRound`, `/rounds/:id/manage` → `RoundManage`; "Manage" nav link for coordinators; `+ Round` button in nav
- `apps/web/src/pages/rounds/RoundsList.tsx`: Added "Manage" link per row and "+ Create Round" button for coordinators
- `apps/web/src/pages/rounds/RoundDetail.tsx`: Added "Manage" button in header for coordinators

### Phase 4 — PDF, Email & PureTrack ✅ COMPLETE
- [x] Puppeteer PDF generation in lock Function (`puppeteer-core` + `@sparticuz/chromium`, Handlebars template) — `apps/api/src/lib/pdf.ts`
- [x] ACS Email integration (`@azure/communication-email`) — send round brief PDF on lock; send auth emails (verify, reset) in Phase 5 — `apps/api/src/lib/email.ts`
- [x] Terraform: add `azurerm_communication_service`, `azurerm_email_communication_service`, `azurerm_email_communication_service_domain` (CustomerManaged); output DNS verification records; add `ACS_CONNECTION_STRING` app setting — `iac/acs.tf`, `iac/functions.tf`, `iac/outputs.tf`
- [x] PureTrack API integration (create round group + per-team groups, add pilots — called on lock) — `apps/api/src/lib/puretrack.ts`, `apps/api/src/functions/puretrack.ts`
- [x] Round brief view/download in UI (`apps/web/src/pages/rounds/RoundBrief.tsx`)
- [x] New API endpoints: `GET /api/rounds/{id}/brief`, `GET /api/rounds/{id}/brief/pdf`, `POST /api/rounds/{id}/puretrack/create-groups` — `apps/api/src/functions/brief.ts`, `apps/api/src/functions/puretrack.ts`

**ACS Email send shape (lock Function):**
```typescript
import { EmailClient } from "@azure/communication-email";
const client = new EmailClient(process.env.ACS_CONNECTION_STRING!);
await client.beginSend({
  senderAddress: "noreply@<custom-domain>",
  recipients: { to: pilots.map(p => ({ address: p.email })) },
  content: { subject: `Round Brief — ${round.site.name}`, html: renderedHtml },
  attachments: [{ name: "brief.pdf", contentType: "application/pdf", contentInBytes: pdfBytes }]
});
```

### Phase 5 — Auth & User Management ✅ COMPLETE
- [x] Add `bcryptjs` (+ `@types/bcryptjs`) to `apps/api` dependencies
- [x] Auth Functions: `POST /api/auth/register`, `GET /api/auth/verify`, `POST /api/auth/resend-verification`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`
- [x] ACS Email templates: email verification, password reset (HTML + text; reuses ACS client from Phase 4)
- [x] Frontend: Login, Register, VerifyEmail, ForgotPassword, ResetPassword pages
- [x] Admin: user list + role assignment (`GET/PUT /api/admin/users`) — `AdminUsers.tsx`
- [x] Pilot profile edit (own profile — `PUT /api/pilots/{id}` self-service) — `PilotProfile.tsx`
- [x] Admin: club/site CRUD, config (`POST/PUT /api/clubs`, `POST/PUT /api/sites`, `GET/PUT /api/admin/config`) — `AdminClubs.tsx`, `AdminSites.tsx`, `AdminConfig.tsx`
- [x] `AuthError` class exported from `useAuth.ts` with `code` field for structured error handling
- [x] Router updated with all new routes; Admin nav links shown to Admin role users

### Phase 6 — Migration & Cutover ✅ COMPLETE

**Tooling implemented this session:**

- [x] Fixed `scripts/migrate/migrate.mjs` — `computeLeague()` was returning `[]` and `buildResults()` was returning empty `teamResults`. Both are now fully ported from `packages/scoring` and `apps/api/src/lib/recompute.ts`. Round docs are collected in a `roundDocs` Map during step 8 and consumed in step 10 for both league and results computation.
- [x] Created `scripts/migrate/validate.mjs` — post-migration blob validation script. Checks all required top-level blobs, spot-checks per-entity docs, asserts league tables are non-empty when rounds exist. Exit code 0 = pass. Run with `BLOB_CONNECTION_STRING=... node scripts/migrate/validate.mjs`.
- [x] Created `scripts/perf-check.mjs` — performance validation. Fetches all key public URLs (blob direct reads + API endpoints) N times, reports median response times, fails if any exceed 500ms (configurable via `THRESHOLD_MS`). Run with `BASE_URL=... BLOB_BASE_URL=... node scripts/perf-check.mjs`.

**Schema audit fixes (from BCC_DB.bacpac model.xml analysis):**

- [x] **Pilots query** — `Manufacturer_ID` is a direct column on `Pilots`, not on `RoundTeamPilots`. Fixed query to `LEFT JOIN Manufacturers mfr ON mfr.ID = p.Manufacturer_ID` instead of a correlated subquery through RoundTeamPilots.
- [x] **Flights query** — `Flights` has `roundTeamPlace_ID` as a direct FK to `RoundTeamPlaces`. Fixed query to `LEFT JOIN RoundTeamPlaces rp ON rp.ID = f.roundTeamPlace_ID` instead of a multi-table correlated subquery.
- [x] **RoundTeamPlaces pilot rating** — `PilotRatings` join was using a redundant self-referencing subquery (`SELECT TOP 1 x.Pilot_Rating_ID FROM RoundTeamPilots x WHERE x.ID = rtp.ID`). Simplified to `LEFT JOIN PilotRatings pr ON pr.ID = rtp.Pilot_Rating_ID`.
- [x] **mapStatus()** — Added handling for statuses present in DB but not in app schema: `Submitted → Proposed`, `Verified → Confirmed`, `Deleted → Cancelled`. Also normalised `Brief Complete` (with space) alongside `BriefComplete`.

**Operational cutover steps (no code required):**

- [ ] Run `node scripts/migrate/migrate.mjs` against production SQL DB; verify with `node scripts/migrate/validate.mjs`
- [ ] UAT with existing RoundsCoord + Admin users — register via `/register`, verify email auto-links to pilot record
- [ ] Deploy SWA + Functions via CI/CD (`deploy-web.yml`, `deploy-api.yml`) — confirm `GET /api/health` returns 200
- [ ] Run `node scripts/perf-check.mjs` — all public URLs must respond < 500ms
- [ ] Add ACS Email DNS records from `terraform output acs_domain_verification_records` at registrar; wait for domain verification in Azure Portal
- [ ] Update DNS CNAME/A for `bcc.org.uk` (or equivalent) to point to SWA default hostname
- [ ] Monitor for 48 h — check Application Insights / SWA analytics for errors
- [ ] Decommission: `terraform destroy -target=azurerm_mssql_server.main -target=azurerm_windows_web_app.main` (or comment out those resources in old `_current/iac/` Terraform)

---

## Key Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Frontend framework | React + TypeScript | Widest ecosystem, SWA first-class support |
| Functions language | TypeScript (Node.js 20) | Consistent with frontend, fast cold start |
| Auth provider | Self-hosted (Functions + Blob + ACS Email) | Azure AD B2C closed to new customers (deprecated May 2025); self-hosted is $0, no external dependency, fits the existing blob-as-database pattern; token surface is simple at this scale |
| Role storage | Blob (`data/users/{id}.json`) | No external API dependency; easy admin via UI |
| Pilot identity | Fully implicit — auto-linked on email match at registration | No user action required; migration stores email on pilot records |
| Token format | HS256 JWT, `JWT_SECRET` app setting | Simpler than JWKS/RS256 at this scale; no key rotation complexity; secret rotatable via app setting |
| Database | Azure Blob Storage (JSON) | Primary cost driver eliminated; write volume trivially low |
| Blob structure | Normalised pilot refs + safety/scoring snapshot at lock time | Avoids stale pilot data in rounds; snapshot is trimmed to only fields with correctness implications (scoring + safety); pilot names/details read from pilot blob on demand |
| Multi-blob consistency | Sequential writes + recompute endpoint | Simple, recoverable; no distributed transactions needed |
| Email service | Azure Communication Services Email (`@azure/communication-email`) | SendGrid no longer available / pricing changed; ACS Email is pay-per-email ($0.00025), 100/day free, native Azure SDK, no external vendor account; at <100 emails/month cost is effectively $0; custom sender domain (DKIM/SPF/DMARC) for deliverability |
| PDF generation | Puppeteer (`@sparticuz/chromium`) | Self-contained in Functions; no external service |
| Data migration | Full migration required | Existing seasons/rounds/pilots/flights must be preserved |
| Azurite init container | `node:20-alpine` + hand-rolled Shared Key HMAC | azure-cli 2.84.0 has a regression in `@azure/storage-blob` 12.28.0 that produces wrong canonical resource for path-style URLs → 403; rolling our own HMAC in Node.js built-ins sidesteps it entirely |
