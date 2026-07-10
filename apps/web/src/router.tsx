// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Link, NavLink, Navigate, useLocation, type NavLinkRenderProps } from "react-router";
import * as z from "zod/v4";
import { SeasonSummarySchema } from "@bccweb/schemas";
import { useAuth, loginUrl } from "./hooks/useAuth.js";
import { AuthProvider } from "./components/AuthProvider.js";
import { useBlob } from "./hooks/useBlob.js";
import type { SeasonSummary } from "@bccweb/types";
import { NavDropdown } from "./components/NavDropdown.js";
import { LoadingSpinner } from "./components/LoadingSpinner.js";
const Home = lazy(() => import("./pages/Home.js"));
const RoundsList = lazy(() => import("./pages/rounds/RoundsList.js"));
const RoundDetail = lazy(() => import("./pages/rounds/RoundDetail.js"));
const CreateRound = lazy(() => import("./pages/rounds/CreateRound.js"));
const RoundManage = lazy(() => import("./pages/rounds/RoundManage.js"));
const RoundBrief = lazy(() => import("./pages/rounds/RoundBrief.js"));
const SignToFly = lazy(() => import("./pages/rounds/SignToFly.js"));
const RegisterForRound = lazy(() => import("./pages/rounds/RegisterForRound.js"));
const League = lazy(() => import("./pages/results/League.js"));
const RoundResults = lazy(() => import("./pages/results/RoundResults.js"));
const PilotsList = lazy(() => import("./pages/pilots/PilotsList.js"));
const PilotProfile = lazy(() => import("./pages/pilots/PilotProfile.js"));
const Profile = lazy(() => import("./pages/Profile.js"));
const Login = lazy(() => import("./pages/auth/Login.js"));
const Register = lazy(() => import("./pages/auth/Register.js"));
const VerifyEmail = lazy(() => import("./pages/auth/VerifyEmail.js"));
const ForgotPassword = lazy(() => import("./pages/auth/ForgotPassword.js"));
const ResetPassword = lazy(() => import("./pages/auth/ResetPassword.js"));
const Terms = lazy(() => import("./pages/Terms.js"));
const About = lazy(() => import("./pages/About.js"));
const AdminUsers = lazy(() => import("./pages/admin/Users.js"));
const AdminClubs = lazy(() => import("./pages/admin/Clubs.js"));
const AdminSeasons = lazy(() => import("./pages/admin/Seasons.js"));
const SeasonClubs = lazy(() => import("./pages/admin/SeasonClubs.js"));
const PilotSeasonClubs = lazy(() => import("./pages/admin/PilotSeasonClubs.js"));
const AdminSites = lazy(() => import("./pages/admin/Sites.js"));
const AdminConfig = lazy(() => import("./pages/admin/Config.js"));
const AdminManufacturers = lazy(() => import("./pages/admin/Manufacturers.js"));
const SignToFlyWording = lazy(() => import("./pages/admin/SignToFlyWording.js"));
const MyClub = lazy(() => import("./pages/club/MyClub.js"));
import FirstLoginOfSeasonGate from "./components/FirstLoginOfSeasonGate.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./bcc-theme.css";

const navLinkClass = ({ isActive }: NavLinkRenderProps) => (isActive ? "active" : "");

function InformationMenu() {
  return (
    <NavDropdown label="Information">
      <NavLink to="/about" className={navLinkClass}>About the BCC</NavLink>
      <a href="/static/BCCRulesUpdateApril2025.pdf" target="_blank" rel="noopener noreferrer">BCC Rules</a>
      <a href="/static/AdvanceBCCBriefingAideMemoireApr2025.pdf" target="_blank" rel="noopener noreferrer">Briefing Aide Memoire</a>
      <a href="/static/bcccovidra_04_2022.pdf" target="_blank" rel="noopener noreferrer">COVID Risk Assessment</a>
      <a href="/static/ParaglidingSOPsv1.7.pdf" target="_blank" rel="noopener noreferrer">Paragliding SOPs</a>
    </NavDropdown>
  );
}

// Mounted only for admins, so its document-level listeners never attach for other roles.
function AdminMenu() {
  return (
    <NavDropdown label="Admin">
      <NavLink to="/admin/clubs" className={navLinkClass}>
        Clubs
      </NavLink>
      <NavLink to="/admin/config" className={navLinkClass}>
        Config
      </NavLink>
      <NavLink to="/admin/manufacturers" className={navLinkClass}>
        Manufacturers
      </NavLink>
      <NavLink to="/admin/seasons" className={navLinkClass}>
        Seasons
      </NavLink>
      <NavLink to="/admin/sign-to-fly-wording" className={navLinkClass}>
        Sign-to-fly wording
      </NavLink>
      <NavLink to="/admin/sites" className={navLinkClass}>
        Sites
      </NavLink>
      <NavLink to="/admin/users" className={navLinkClass}>
        Users
      </NavLink>
    </NavDropdown>
  );
}

export function Nav() {
  const { identity, loading, logout } = useAuth();

  const isCoord =
    identity?.roles.includes("RoundsCoord") ||
    identity?.roles.includes("Admin");

  const isAdmin = identity?.roles.includes("Admin");

  return (
    <nav className="bcc-nav">
      <Link to="/" className="bcc-nav__logo">
        <img src="/images/BCC_logo.png" alt="British Club Challenge" />
      </Link>

      <div className="bcc-nav__links">
        <NavLink to="/rounds" className={navLinkClass}>
          Rounds
        </NavLink>
        <NavLink to="/results" className={navLinkClass}>
          Results
        </NavLink>
        <InformationMenu />
        {isCoord && (
          <NavLink to="/pilots" className={navLinkClass}>
            Pilots
          </NavLink>
        )}
        {isCoord && (
          <NavLink to="/rounds/new" className={navLinkClass}>
            + New Round
          </NavLink>
        )}
        {isCoord && !isAdmin && (
          <NavLink to="/club" className={navLinkClass}>
            My Club
          </NavLink>
        )}
        {isCoord && !isAdmin && (
          <NavLink to="/admin/sites" className={navLinkClass}>
            Sites
          </NavLink>
        )}
        {isAdmin && <AdminMenu />}
      </div>

      <div className="bcc-nav__auth">
        {loading ? null : identity ? (
          <>
            <NavLink to="/profile" className={navLinkClass}>
              {identity.email}
            </NavLink>
            <button onClick={logout}>Sign out</button>
          </>
        ) : (
          <Link to="/login">Sign in</Link>
        )}
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="bcc-footer">
      <a href="https://www.bhpa.co.uk" target="_blank" rel="noopener noreferrer" title="British Hang Gliding & Paragliding Association">
        <img src="/images/bhpa.png" alt="BHPA" />
      </a>
      <a href="https://www.advance.swiss/en/" target="_blank" rel="noopener noreferrer" title="ADVANCE">
        <img src="/images/AdvanceLogo.jpg" alt="Advance" />
      </a>
      <a href="https://pgcomps.org.uk/" target="_blank" rel="noopener noreferrer" title="British Paragliding Competitions">
        <img src="/images/PgcompsLogo100x100alt.jpg" alt="British Paragliding Competitions" />
      </a>
    </footer>
  );
}

/**
 * Wraps routes that require a logged-in user.
 * Shows nothing while auth is initialising (avoids flash-redirect).
 * Redirects to /login with a ?return= param when signed out.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { identity, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!identity) return <Navigate to={loginUrl(location.pathname)} replace />;
  return <>{children}</>;
}

/**
 * Wraps routes that require Admin or RoundsCoord role.
 * Redirects unauthenticated users to /login and Pilot-only users to /.
 */
function RequireCoord({ children }: { children: React.ReactNode }) {
  const { identity, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!identity) return <Navigate to={loginUrl(location.pathname)} replace />;
  const isCoord =
    identity.roles.includes("RoundsCoord") ||
    identity.roles.includes("Admin");
  if (!isCoord) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Redirect /results → /results/:activeYear (or first season year) */
function ResultsRedirect() {
  const { data: seasons } = useBlob<SeasonSummary[]>("seasons.json", z.array(SeasonSummarySchema));
  if (!seasons) return null; // wait for data
  const active = seasons.find((s) => s.active) ?? seasons[seasons.length - 1];
  if (!active) return <Navigate to="/" replace />;
  return <Navigate to={`/results/${active.year}`} replace />;
}

/** Wraps inner pages (non-Home) with consistent padding/max-width */
function Page({ children }: { children: React.ReactNode }) {
  return <div className="bcc-page">{children}</div>;
}

export default function App() {
  return (
    // useTransitions: enable React Router's enhanced transition-wrapped navigation
    // (router state updates + <Link>/<Form> navigations wrapped in React.startTransition). Resolves #42.
    <BrowserRouter useTransitions={true}>
      <AuthProvider>
        <FirstLoginOfSeasonGate><Nav />
        <main className="bcc-main">
          <RoutedContent />
        </main>
        <Footer /></FirstLoginOfSeasonGate>
      </AuthProvider>
    </BrowserRouter>
  );
}

function RoutedContent() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<LoadingSpinner />}>
      <Routes>
          <Route path="/" element={<Home />} />

          {/* Rounds */}
          <Route path="/rounds" element={<RequireAuth><Page><RoundsList /></Page></RequireAuth>} />
          <Route path="/rounds/new" element={<RequireAuth><Page><CreateRound /></Page></RequireAuth>} />
          <Route path="/rounds/:id" element={<RequireAuth><Page><RoundDetail /></Page></RequireAuth>} />
          <Route path="/rounds/:id/register" element={<RequireAuth><Page><RegisterForRound /></Page></RequireAuth>} />
          <Route path="/rounds/:id/manage" element={<RequireAuth><Page><RoundManage /></Page></RequireAuth>} />
          <Route path="/rounds/:id/brief" element={<RequireAuth><Page><RoundBrief /></Page></RequireAuth>} />
          <Route path="/rounds/:roundId/sign/:teamId/:place" element={<RequireAuth><Page><SignToFly /></Page></RequireAuth>} />

          {/* Results / League — public */}
          <Route path="/results" element={<ResultsRedirect />} />
          <Route path="/results/:year" element={<Page><League /></Page>} />
          <Route path="/results/:year/rounds" element={<Page><RoundResults /></Page>} />

          {/* Pilots */}
          <Route path="/pilots" element={<RequireCoord><Page><PilotsList /></Page></RequireCoord>} />
          <Route path="/pilots/:id" element={<RequireAuth><Page><PilotProfile /></Page></RequireAuth>} />

          {/* My profile — self-claim if no pilotId, otherwise redirects to /pilots/{id} */}
          <Route path="/profile" element={<RequireAuth><Page><Profile /></Page></RequireAuth>} />

          {/* Auth */}
          <Route path="/login" element={<Page><Login /></Page>} />
          <Route path="/register" element={<Page><Register /></Page>} />
          <Route path="/terms" element={<Page><Terms /></Page>} />
          <Route path="/about" element={<Page><About /></Page>} />
          <Route path="/verify-email" element={<Page><VerifyEmail /></Page>} />
          <Route path="/forgot-password" element={<Page><ForgotPassword /></Page>} />
          <Route path="/reset-password" element={<Page><ResetPassword /></Page>} />

          {/* Admin */}
          <Route path="/admin/users" element={<RequireAuth><Page><AdminUsers /></Page></RequireAuth>} />
          <Route path="/admin/clubs" element={<RequireAuth><Page><AdminClubs /></Page></RequireAuth>} />
          <Route path="/admin/manufacturers" element={<RequireAuth><Page><AdminManufacturers /></Page></RequireAuth>} />
          <Route path="/admin/seasons" element={<RequireAuth><Page><AdminSeasons /></Page></RequireAuth>} />
          <Route path="/admin/seasons/:year/clubs" element={<RequireAuth><Page><SeasonClubs /></Page></RequireAuth>} />
          <Route path="/admin/pilot-season-clubs" element={<RequireAuth><Page><PilotSeasonClubs /></Page></RequireAuth>} />
          <Route path="/admin/sign-to-fly-wording" element={<RequireAuth><Page><SignToFlyWording /></Page></RequireAuth>} />
          <Route path="/admin/sites" element={<RequireCoord><Page><AdminSites /></Page></RequireCoord>} />
          <Route path="/admin/config" element={<RequireAuth><Page><AdminConfig /></Page></RequireAuth>} />

          {/* Club — RoundsCoord self-service */}
          <Route path="/club" element={<RequireAuth><Page><MyClub /></Page></RequireAuth>} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
