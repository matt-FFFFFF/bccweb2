import type { CallerIdentity } from "@bccweb/types";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router";

// ─── Auth error ──────────────────────────────────────────────────────────────

/**
 * Thrown by `login()` when the API returns a structured error code.
 * Check `code` to handle specific cases (e.g. EMAIL_NOT_VERIFIED).
 */
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// ─── Storage keys ─────────────────────────────────────────────────────────

const ACCESS_TOKEN_KEY = "bcc_access_token";
const REFRESH_TOKEN_KEY = "bcc_refresh_token";
const IDENTITY_KEY = "bcc_identity";

// ─── Token helpers ────────────────────────────────────────────────────────

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

/** Decode a JWT payload without verifying the signature (client-side only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(atob(payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload["exp"] !== "number") return true;
  // Treat as expired 30 seconds before actual expiry to avoid edge cases
  return Date.now() >= (payload["exp"] as number) * 1000 - 30_000;
}

function clearAuthStorage() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(IDENTITY_KEY);
}

// ─── Hook ─────────────────────────────────────────────────────────────────

export interface AuthState {
  /** True while the initial auth check is in flight */
  loading: boolean;
  /** The authenticated user's identity, or null if not signed in */
  identity: CallerIdentity | null;
  /** True while apiFetch is in the middle of a token refresh */
  isRefreshing: boolean;
  /**
   * Sign in with email and password. Throws an Error with a human-readable
   * message on failure (wrong credentials, unverified email, etc.).
   */
  login: (email: string, password: string) => Promise<void>;
  /** Sign out and clear stored tokens. */
  logout: () => void;
  /** Re-fetch /api/me with the stored access token and update state/storage. */
  refreshIdentity: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthState | null>(null);

/**
 * Provides auth state to the entire app. Mount once at the root (inside
 * BrowserRouter so children can call useNavigate if needed).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [identity, setIdentity] = useState<CallerIdentity | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
      const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
      const storedIdentity = localStorage.getItem(IDENTITY_KEY);

      // Valid access token + cached identity — no network call needed
      if (accessToken && !isTokenExpired(accessToken) && storedIdentity) {
        try {
          const parsed = JSON.parse(storedIdentity) as CallerIdentity;
          if (!cancelled) {
            setIdentity(parsed);
            setLoading(false);
          }
          return;
        } catch {
          // Corrupt storage — fall through to refresh
        }
      }

      // Try to refresh using the refresh token
      if (refreshToken && !isTokenExpired(refreshToken)) {
        try {
          const res = await fetch("/api/auth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken }),
          });

          if (res.ok) {
            const { accessToken: newToken } =
              (await res.json()) as RefreshResponse;
            localStorage.setItem(ACCESS_TOKEN_KEY, newToken);

            const meRes = await fetch("/api/me", {
              headers: { Authorization: `Bearer ${newToken}` },
            });

            if (meRes.ok) {
              const fresh = (await meRes.json()) as CallerIdentity;
              localStorage.setItem(IDENTITY_KEY, JSON.stringify(fresh));
              if (!cancelled) {
                setIdentity(fresh);
                setLoading(false);
              }
              return;
            }
          }
        } catch {
          // Refresh failed — fall through to signed-out state
        }
      }

      // No valid session
      clearAuthStorage();
      if (!cancelled) {
        setIdentity(null);
        setLoading(false);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
      throw new AuthError(body?.code ?? "LOGIN_FAILED", body?.error ?? "Login failed");
    }

    const { accessToken, refreshToken } =
      (await res.json()) as LoginResponse;

    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);

    const meRes = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!meRes.ok) throw new Error("Failed to load user profile");

    const fresh = (await meRes.json()) as CallerIdentity;
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(fresh));
    setIdentity(fresh);
    setLoading(false);
  }, []);

  const logout = useCallback(() => {
    clearAuthStorage();
    setIdentity(null);
    setLoading(false);
  }, []);

  const refreshIdentity = useCallback(async () => {
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!accessToken) return;
    const meRes = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meRes.ok) return;
    const fresh = (await meRes.json()) as CallerIdentity;
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(fresh));
    setIdentity(fresh);
  }, []);

  // Track in-progress refresh so consumers can show a loading indicator
  useEffect(() => {
    const onStart = () => setIsRefreshing(true);
    const onEnd = () => setIsRefreshing(false);
    window.addEventListener("bcc:refresh-start", onStart);
    window.addEventListener("bcc:refresh-end", onEnd);
    return () => {
      window.removeEventListener("bcc:refresh-start", onStart);
      window.removeEventListener("bcc:refresh-end", onEnd);
    };
  }, []);

  // When apiFetch exhausts the refresh (refresh itself fails), clear local
  // state and redirect to the login page preserving the return destination.
  useEffect(() => {
    const handleAuthExpired = () => {
      logout();
      const returnPath = window.location.pathname + window.location.search;
      navigate(loginUrl(returnPath));
    };
    window.addEventListener("bcc:auth-expired", handleAuthExpired);
    return () => window.removeEventListener("bcc:auth-expired", handleAuthExpired);
  }, [logout, navigate]);

  const value: AuthState = { loading, identity, isRefreshing, login, logout, refreshIdentity };
  return <AuthContext value={value}>{children}</AuthContext>;
}

/** Returns shared auth state. Must be used inside <AuthProvider>. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Path to the sign-in page (optionally with a return destination). */
export function loginUrl(returnPath = "/") {
  return `/login?return=${encodeURIComponent(returnPath)}`;
}
