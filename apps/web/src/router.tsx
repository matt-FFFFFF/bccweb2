import { BrowserRouter, Routes, Route, Link, NavLink, Navigate, useLocation } from "react-router-dom";
import { useAuth, AuthProvider, loginUrl } from "./hooks/useAuth.js";
import { useBlob } from "./hooks/useBlob.js";
import type { SeasonSummary } from "@bccweb/types";
import Home from "./pages/Home.js";
import RoundsList from "./pages/rounds/RoundsList.js";
import RoundDetail from "./pages/rounds/RoundDetail.js";
import CreateRound from "./pages/rounds/CreateRound.js";
import RoundManage from "./pages/rounds/RoundManage.js";
import RoundBrief from "./pages/rounds/RoundBrief.js";
import SignToFly from "./pages/rounds/SignToFly.js";
import RegisterForRound from "./pages/rounds/RegisterForRound.js";
import League from "./pages/results/League.js";
import RoundResults from "./pages/results/RoundResults.js";
import PilotsList from "./pages/pilots/PilotsList.js";
import PilotProfile from "./pages/pilots/PilotProfile.js";
import Login from "./pages/auth/Login.js";
import Register from "./pages/auth/Register.js";
import VerifyEmail from "./pages/auth/VerifyEmail.js";
import ForgotPassword from "./pages/auth/ForgotPassword.js";
import ResetPassword from "./pages/auth/ResetPassword.js";
import Terms from "./pages/Terms.js";
import AdminUsers from "./pages/admin/Users.js";
import AdminClubs from "./pages/admin/Clubs.js";
import AdminSites from "./pages/admin/Sites.js";
import AdminConfig from "./pages/admin/Config.js";
import MyClub from "./pages/club/MyClub.js";
import FirstLoginOfSeasonGate from "./components/FirstLoginOfSeasonGate.js";
import "./bcc-theme.css";

function Nav() {
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
        <NavLink to="/rounds" className={({ isActive }) => isActive ? "active" : ""}>
          Rounds
        </NavLink>
        <NavLink to="/results" className={({ isActive }) => isActive ? "active" : ""}>
          Results
        </NavLink>
        {isCoord && (
          <NavLink to="/pilots" className={({ isActive }) => isActive ? "active" : ""}>
            Pilots
          </NavLink>
        )}
        {isCoord && (
          <NavLink to="/rounds/new" className={({ isActive }) => isActive ? "active" : ""}>
            + New Round
          </NavLink>
        )}
        {isCoord && !isAdmin && (
          <NavLink to="/club" className={({ isActive }) => isActive ? "active" : ""}>
            My Club
          </NavLink>
        )}
        {isAdmin && (
          <>
            <NavLink to="/admin/users" className={({ isActive }) => isActive ? "active" : ""}>
              Users
            </NavLink>
            <NavLink to="/admin/clubs" className={({ isActive }) => isActive ? "active" : ""}>
              Clubs
            </NavLink>
            <NavLink to="/admin/sites" className={({ isActive }) => isActive ? "active" : ""}>
              Sites
            </NavLink>
            <NavLink to="/admin/config" className={({ isActive }) => isActive ? "active" : ""}>
              Config
            </NavLink>
          </>
        )}
      </div>

      <div className="bcc-nav__auth">
        {loading ? null : identity ? (
          <>
            <span>{identity.email}</span>
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
      <a href="https://www.bhpa.co.uk" target="_blank" rel="noreferrer" title="British Hang Gliding & Paragliding Association">
        <img src="/images/bhpa.png" alt="BHPA" />
      </a>
      <a href="https://www.advance.swiss/en/" target="_blank" rel="noreferrer" title="ADVANCE">
        <img src="/images/AdvanceLogo.jpg" alt="Advance" />
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
  const { data: seasons } = useBlob<SeasonSummary[]>("seasons.json");
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
    <BrowserRouter>
      <AuthProvider>
        <FirstLoginOfSeasonGate><Nav />
        <main className="bcc-main">
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

          {/* Auth */}
          <Route path="/login" element={<Page><Login /></Page>} />
          <Route path="/register" element={<Page><Register /></Page>} />
          <Route path="/terms" element={<Page><Terms /></Page>} />
          <Route path="/verify-email" element={<Page><VerifyEmail /></Page>} />
          <Route path="/forgot-password" element={<Page><ForgotPassword /></Page>} />
          <Route path="/reset-password" element={<Page><ResetPassword /></Page>} />

          {/* Admin */}
          <Route path="/admin/users" element={<RequireAuth><Page><AdminUsers /></Page></RequireAuth>} />
          <Route path="/admin/clubs" element={<RequireAuth><Page><AdminClubs /></Page></RequireAuth>} />
          <Route path="/admin/sites" element={<RequireAuth><Page><AdminSites /></Page></RequireAuth>} />
          <Route path="/admin/config" element={<RequireAuth><Page><AdminConfig /></Page></RequireAuth>} />

          {/* Club — RoundsCoord self-service */}
          <Route path="/club" element={<RequireAuth><Page><MyClub /></Page></RequireAuth>} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </main>
        <Footer /></FirstLoginOfSeasonGate>
      </AuthProvider>
    </BrowserRouter>
  );
}
