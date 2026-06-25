/**
 * Auth Functions — Phase 5
 *
 * POST /api/auth/register            — register with email + password
 * GET  /api/auth/verify              — verify email via token from email link
 * POST /api/auth/resend-verification — resend verification email
 * POST /api/auth/login               — email + password → access + refresh tokens
 * POST /api/auth/refresh             — refresh token → new access token
 * POST /api/auth/forgot-password     — send password reset email
 * POST /api/auth/reset-password      — reset password via token
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createHash, randomBytes, randomUUID } from "crypto";
import * as z from "zod/v4";
import type { User } from "@bccweb/types";
import { AuthCredentialSchema, UserSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  writePrivateBlob,
  withPrivateLease,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";

const VerificationStateSchema = z.object({
  token: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
import { getCallerIdentity, getOrCreateUser, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { extractIp } from "../lib/signTofly/ledger.js";
import {
  AuthCredential,
  TokenAlreadyConsumedError,
  TokenExpiredError,
  TokenNotFoundError,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashPassword,
  verifyPassword,
  generateShortLivedToken,
  consumeShortLivedToken,
  lookupUserByEmail,
  getAppUrl,
} from "../lib/authHelpers.js";
import {
  checkAccountLockout,
  rateLimit,
  recordLoginFailure,
  recordLoginSuccess,
} from "../lib/rateLimit.js";
import {
  sendEmail,
  verificationEmailHtml,
  verificationEmailText,
  passwordResetEmailHtml,
  passwordResetEmailText,
} from "../lib/email.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(message: string): HttpResponseInit {
  throw new HttpError(400, "INVALID_BODY", message);
}

const REGISTER_ACCEPTED_BODY = {
  status: "accepted",
  message:
    "If this email is not yet registered, you will receive a verification link shortly.",
} as const;

const REGISTER_ACCEPTED_RESPONSE: HttpResponseInit = {
  status: 202,
  jsonBody: REGISTER_ACCEPTED_BODY,
};

const VERIFICATION_TOKEN_REISSUE_WINDOW_MS = 60_000;

interface VerificationState {
  token: string;
  createdAt: string;
  expiresAt: string;
}

function hashEmailPrefix(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 8);
}

function verificationStatePath(userId: string): string {
  return `auth/verification-state/${userId}.json`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureMinimumDuration(startedAtMs: number, minimumMs: number): Promise<void> {
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < minimumMs) {
    await sleep(minimumMs - elapsed);
  }
}

async function storeVerificationToken(
  userId: string,
  rawToken: string,
  ttlHours: number
): Promise<VerificationState> {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const tokenDoc: VerificationState = { token: rawToken, createdAt, expiresAt };

  // CREATE-ONCE: token path is sha256-keyed, collision means token already issued
  await writePrivateBlob(`auth/tokens/${tokenHash}.json`, {
    userId,
    type: "verify",
    createdAt,
    expiresAt,
  });
  // CREATE-ONCE: token path is sha256-keyed, collision means token already issued
  await writePrivateBlob(verificationStatePath(userId), tokenDoc);
  return tokenDoc;
}

async function createVerificationToken(userId: string, ttlHours: number): Promise<VerificationState> {
  const rawToken = randomBytes(32).toString("hex");
  return storeVerificationToken(userId, rawToken, ttlHours);
}

async function loadVerificationState(userId: string): Promise<VerificationState | null> {
  const path = verificationStatePath(userId);
  try {
    return await readJson(getPrivateBlobClient(path), VerificationStateSchema, path);
  } catch {
    return null;
  }
}

async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${getAppUrl()}/verify-email?token=${token}`;
  try {
    await sendEmail({
      to: [email],
      subject: "Verify your BCC account",
      html: verificationEmailHtml(verifyUrl),
      text: verificationEmailText(verifyUrl),
    });
  } catch (err) {
    console.error("[auth/register] Failed to send verification email:", err);
  }
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────

async function register(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  rateLimit(req, { endpoint: "register", capacity: 3, refillPerMin: 3 });
  const startedAtMs = Date.now();
  let body: { email?: string; password?: string; acceptTsCs?: boolean; acceptedTsCsVersion?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  const { email, password, acceptTsCs, acceptedTsCsVersion } = body;
  if (acceptTsCs !== true || typeof acceptedTsCsVersion !== "number") {
    throw new HttpError(400, "TS_CS_NOT_ACCEPTED", "Terms & Conditions must be accepted before registration.");
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    return badRequest("Invalid email address");
  }
  if (!password || password.length < 8) {
    return badRequest("Password must be at least 8 characters");
  }

  const emailLower = email.toLowerCase();
  const emailHashPrefix = hashEmailPrefix(emailLower);
  const existing = await lookupUserByEmail(emailLower);

  let branchLabel = "new-email";

  if (!existing) {
    const userId = randomUUID();
    const credential: AuthCredential = {
      passwordHash: await hashPassword(password),
      emailVerified: false,
      createdAt: new Date().toISOString(),
    };
    await writePrivateJson(
      `auth/${userId}.json`,
      AuthCredentialSchema,
      credential,
      undefined,
      { ifNoneMatch: "*" },
    );
    const user = await getOrCreateUser(userId, emailLower);
    const acceptedAt = new Date().toISOString();
    await writePrivateJson(`users/${userId}.json`, UserSchema, {
      ...user,
      acceptedTsCsAt: acceptedAt,
      acceptedTsCsIp: extractIp(req),
      acceptedTsCsVersion,
    });

    const tokenDoc = await createVerificationToken(userId, 24);
    await sendVerificationEmail(emailLower, tokenDoc.token);
  } else {
    let cred: AuthCredential | null = null;
    try {
      const credPath = `auth/${existing}.json`;
      cred = await readJson(
        getPrivateBlobClient(credPath),
        AuthCredentialSchema,
        credPath,
      );
    } catch {
      cred = null;
    }

    if (cred?.emailVerified) {
      branchLabel = "existing-verified";
    } else {
      const state = await loadVerificationState(existing);
      const now = Date.now();
      const freshState = state && now - new Date(state.createdAt).getTime() < VERIFICATION_TOKEN_REISSUE_WINDOW_MS;

      branchLabel = freshState ? "existing-unverified-reuse" : "existing-unverified-reissue";
      const tokenDoc = freshState && state ? state : await createVerificationToken(existing, 24);
      await sendVerificationEmail(emailLower, tokenDoc.token);
    }
  }

  console.log("[auth] register branch:", branchLabel, "for", emailHashPrefix);
  await ensureMinimumDuration(startedAtMs, 100);
  return REGISTER_ACCEPTED_RESPONSE;
}

// ─── GET /api/auth/verify ─────────────────────────────────────────────────────

async function verifyEmail(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  rateLimit(req, { endpoint: "verify-email", capacity: 10, refillPerMin: 10 });
  const token = req.query.get("token");
  if (!token) return badRequest("Missing token");

  let result: { userId: string };
  try {
    result = await consumeShortLivedToken(token, "verify");
  } catch (err: unknown) {
    if (
      err instanceof TokenNotFoundError ||
      err instanceof TokenExpiredError ||
      err instanceof TokenAlreadyConsumedError
    ) {
      throw new HttpError(400, "INVALID_TOKEN", "Invalid or expired token");
    }
    throw new HttpError(500, "INTERNAL");
  }

  const credPath = `auth/${result.userId}.json`;
  await withPrivateLease(credPath, async (leaseId) => {
    let cred: AuthCredential;
    try {
      cred = await readJson(
        getPrivateBlobClient(credPath),
        AuthCredentialSchema,
        credPath,
      );
    } catch {
      throw new HttpError(400, "INVALID_TOKEN", "Invalid token");
    }

    cred.emailVerified = true;
    await writePrivateJson(credPath, AuthCredentialSchema, cred, leaseId);
  });

  return {
    status: 200,
    jsonBody: { success: true, message: "Email verified. You can now sign in." },
  };
}

// ─── POST /api/auth/resend-verification ──────────────────────────────────────

async function resendVerification(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  rateLimit(req, { endpoint: "resend-verification", capacity: 3, refillPerMin: 3 });
  let body: { email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  const { email } = body;
  if (!email) return badRequest("Email is required");

  // Silently succeed if email not found — don't leak existence
  const silentOk: HttpResponseInit = {
    status: 200,
    jsonBody: {
      message:
        "If an unverified account exists with this email, a new verification link has been sent.",
    },
  };

  const userId = await lookupUserByEmail(email);
  if (!userId) return silentOk;

  let cred: AuthCredential;
  try {
    const credPath = `auth/${userId}.json`;
    cred = await readJson(
      getPrivateBlobClient(credPath),
      AuthCredentialSchema,
      credPath,
    );
  } catch {
    return silentOk;
  }

  if (cred.emailVerified) {
    return {
      status: 400,
      jsonBody: {
        error: "This account has already been verified. Please sign in.",
      },
    };
  }

  const token = await generateShortLivedToken(userId, "verify", 24);
  const verifyUrl = `${getAppUrl()}/verify-email?token=${token}`;

  try {
    await sendEmail({
      to: [email],
      subject: "Verify your BCC account",
      html: verificationEmailHtml(verifyUrl),
      text: verificationEmailText(verifyUrl),
    });
  } catch (err) {
    console.error("[auth/resend-verification] Failed to send email:", err);
  }

  return silentOk;
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

async function login(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  rateLimit(req, { endpoint: "login", capacity: 10, refillPerMin: 10 });

  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  const { email, password } = body;
  if (!email || !password) {
    return badRequest("Email and password are required");
  }

  const invalidCreds: HttpResponseInit = {
    status: 401,
    jsonBody: { error: "Invalid email or password" },
  };

  const userId = await lookupUserByEmail(email);
  if (!userId) return invalidCreds;

  // Check lockout before password verification — throws 423 if active
  await checkAccountLockout(userId);

  let cred: AuthCredential;
  try {
    const credPath = `auth/${userId}.json`;
    cred = await readJson(
      getPrivateBlobClient(credPath),
      AuthCredentialSchema,
      credPath,
    );
  } catch {
    return invalidCreds;
  }

  const passwordOk = await verifyPassword(password, cred.passwordHash);
  if (!passwordOk) {
    await recordLoginFailure(userId);
    return invalidCreds;
  }

  if (!cred.emailVerified) {
    return {
      status: 403,
      jsonBody: {
        error:
          "Email not verified. Please check your inbox or request a new verification email.",
        code: "EMAIL_NOT_VERIFIED",
      },
    };
  }

  await recordLoginSuccess(userId);
  const accessToken = signAccessToken(userId, email);
  const refreshToken = signRefreshToken(userId, cred.tokenVersion ?? 0);

  return {
    status: 200,
    jsonBody: { accessToken, refreshToken, expiresIn: 3600 },
  };
}

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────

async function refresh(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  rateLimit(req, { endpoint: "refresh", capacity: 30, refillPerMin: 30 });
  let body: { refreshToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  if (!body.refreshToken) return badRequest("refreshToken is required");

  const invalidRefresh: HttpResponseInit = {
    status: 401,
    jsonBody: { error: "Invalid or expired refresh token" },
  };

  let userId: string;
  let tokenVersion: number;
  try {
    ({ userId, tokenVersion } = verifyRefreshToken(body.refreshToken));
  } catch {
    return invalidRefresh;
  }

  // Reject revoked refresh tokens: tokenVersion is bumped on logout and password
  // reset, so a token issued before the bump no longer matches the stored value.
  let cred: AuthCredential;
  try {
    const credPath = `auth/${userId}.json`;
    cred = await readJson(getPrivateBlobClient(credPath), AuthCredentialSchema, credPath);
  } catch {
    return invalidRefresh;
  }
  if ((cred.tokenVersion ?? 0) !== tokenVersion) {
    return invalidRefresh;
  }

  // Confirm user still exists and get their email
  let user: User;
  try {
    const userPath = `users/${userId}.json`;
    user = await readJson(getPrivateBlobClient(userPath), UserSchema, userPath);
  } catch {
    return { status: 401, jsonBody: { error: "User not found" } };
  }

  const accessToken = signAccessToken(userId, user.email);
  return { status: 200, jsonBody: { accessToken, expiresIn: 3600 } };
}

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────

async function forgotPassword(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  rateLimit(req, { endpoint: "forgot-password", capacity: 3, refillPerMin: 3 });
  let body: { email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  if (!body.email) return badRequest("Email is required");

  // Always return the same response — never reveal whether the email exists
  const silentOk: HttpResponseInit = {
    status: 200,
    jsonBody: {
      message:
        "If an account with this email exists, a password reset link has been sent.",
    },
  };

  const userId = await lookupUserByEmail(body.email);
  if (!userId) return silentOk;

  try {
    const credPath = `auth/${userId}.json`;
    await readJson(getPrivateBlobClient(credPath), AuthCredentialSchema, credPath);
  } catch {
    return silentOk; // account not fully set up
  }

  const token = await generateShortLivedToken(userId, "reset", 1);
  const resetUrl = `${getAppUrl()}/reset-password?token=${token}`;

  try {
    await sendEmail({
      to: [body.email],
      subject: "Reset your BCC password",
      html: passwordResetEmailHtml(resetUrl),
      text: passwordResetEmailText(resetUrl),
    });
  } catch (err) {
    console.error("[auth/forgot-password] Failed to send email:", err);
  }

  return silentOk;
}

// ─── POST /api/auth/reset-password ───────────────────────────────────────────

async function resetPassword(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  rateLimit(req, { endpoint: "reset-password", capacity: 5, refillPerMin: 5 });
  let body: { token?: string; newPassword?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  if (!body.token) return badRequest("token is required");
  if (!body.newPassword || body.newPassword.length < 8) {
    return badRequest("Password must be at least 8 characters");
  }
  const newPassword = body.newPassword;

  let result: { userId: string };
  try {
    result = await consumeShortLivedToken(body.token, "reset");
  } catch (err: unknown) {
    if (
      err instanceof TokenNotFoundError ||
      err instanceof TokenExpiredError ||
      err instanceof TokenAlreadyConsumedError
    ) {
      throw new HttpError(400, "INVALID_TOKEN", "Invalid or expired token");
    }
    throw new HttpError(500, "INTERNAL");
  }

  const credPath = `auth/${result.userId}.json`;
  await withPrivateLease(credPath, async (leaseId) => {
    let cred: AuthCredential;
    try {
      cred = await readJson(
        getPrivateBlobClient(credPath),
        AuthCredentialSchema,
        credPath,
      );
    } catch {
      throw new HttpError(400, "INVALID_TOKEN", "Invalid token");
    }

    cred.passwordHash = await hashPassword(newPassword);
    cred.tokenVersion = (cred.tokenVersion ?? 0) + 1;
    await writePrivateJson(credPath, AuthCredentialSchema, cred, leaseId);
  });

  return {
    status: 200,
    jsonBody: { message: "Password reset successfully. You can now sign in." },
  };
}

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

async function logout(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  rateLimit(req, {
    endpoint: "logout",
    capacity: 10,
    refillPerMin: 10,
    identityKey: caller.userId,
  });

  // SECURITY: bumping tokenVersion revokes every refresh token previously issued
  // to this user (refresh compares the stored version). Missing creds = nothing
  // to revoke, so logout stays idempotent (204).
  const credPath = `auth/${caller.userId}.json`;
  try {
    await withPrivateLease(credPath, async (leaseId) => {
      const cred = await readJson(
        getPrivateBlobClient(credPath),
        AuthCredentialSchema,
        credPath,
      );
      cred.tokenVersion = (cred.tokenVersion ?? 0) + 1;
      await writePrivateJson(credPath, AuthCredentialSchema, cred, leaseId);
    });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 204 };
    }
    throw err;
  }

  return { status: 204 };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("authRegister", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/register",
  handler: withErrorHandler(register),
});

app.http("authVerifyEmail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "auth/verify",
  handler: withErrorHandler(verifyEmail),
});

app.http("authResendVerification", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/resend-verification",
  handler: withErrorHandler(resendVerification),
});

app.http("authLogin", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/login",
  handler: withErrorHandler(login),
});

app.http("authRefresh", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/refresh",
  handler: withErrorHandler(refresh),
});

app.http("authForgotPassword", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/forgot-password",
  handler: withErrorHandler(forgotPassword),
});

app.http("authResetPassword", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/reset-password",
  handler: withErrorHandler(resetPassword),
});

app.http("authLogout", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/logout",
  handler: withErrorHandler(logout),
});
