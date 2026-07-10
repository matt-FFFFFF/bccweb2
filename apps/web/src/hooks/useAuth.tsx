// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { CallerIdentity } from "@bccweb/types";
import { createContext, useContext } from "react";

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

export const AuthContext = createContext<AuthState | null>(null);

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
