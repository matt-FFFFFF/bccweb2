# apps/web/src — React SPA source

Conventions for the SPA tree. Root [AGENTS.md](../../../AGENTS.md) covers `router.tsx`,
`useBlob`, `useAuth`, `api.ts`, route guards, and token storage — not repeated here.

## Import style (REQUIRED)

Relative TS/TSX imports use `.js` extensions everywhere: `../../lib/api.js`,
`./pages/Home.js`, `./hooks/useAuth.js`. Package imports stay extensionless
(`@bccweb/types`, `@bccweb/schemas`). Match this — the build enforces it.

## components/ — shared UI only

One component per file, **named exports**, tiny prop interfaces, inline `style` objects.
Reuse across pages only; page-specific bits stay in the page.
- `LoadingSpinner.tsx` → `LoadingSpinner` + `ErrorMessage` (the shared loading/error pattern)
- `StatusBadge.tsx` → status-to-color mapping
- `BriefImages.tsx` → authenticated image fetch + object-URL cleanup
- `FirstLoginOfSeasonGate.tsx`, `ErrorBoundary.tsx` → default-exported, router-wrapped app guards

## hooks/ — only two

`useBlob.ts` (public blob fetch) and `useAuth.tsx` (auth provider). **Don't add more**
unless genuinely shared — page-local state/effects live inside the page.

## lib/ — gateways + small utils

`api.ts` (`get/post/put/delete/deleteJson`, `ApiError`, auto token refresh w/ single-flight
lock), `blobClient.ts` (public reader behind `useBlob`), `sanitize.ts` (HTML sanitizer for
sign-to-fly wording), `telemetry.ts` (PII redaction + RUM stub), `terms.ts` (T&Cs version).
**All mutations go through `api.ts`** — except multipart upload (raw `fetch` + `FormData`,
see `RoundManage.tsx`).

## public/static/ — vendored legacy PDFs

`apps/web/public/static/` holds vendored legacy public PDFs (BCC Rules, Briefing Aide
Memoire, COVID Risk Assessment, Paragliding SOPs) served at `/static/*.pdf` (Vite copies
`public/` verbatim into `dist/web/`).

## pages/ — route-aligned folders

Folder = route domain (`auth`, `rounds`, `results`, `pilots`, `admin`, `club`; plus top-level
`Home/Profile/Terms/About`). 1:1 with `router.tsx`. Page conventions:
- top-level `useState/useEffect`; helper fns + small nested subcomponents **above** the page
- early-return loading / error / forbidden states
- mutation handlers live in the page file (no shared form layer); inline styles OK

Big pages: `RoundManage.tsx` (~1486 — coordinator control panel: status workflow, metadata,
narrative, teams, slots, flights), `RoundBrief.tsx` (locked brief viewer + PDF/image),
`PilotProfile.tsx` (view/edit profile). Mutation examples: `CreateRound.tsx` →
`api.post("rounds",…)`; `RegisterForRound.tsx` → `…/register-self`; `PilotProfile.tsx` →
`api.put("pilots/:id",…)`; `SignToFly.tsx` → `…/teams/:teamId/pilots/:place/sign`.
