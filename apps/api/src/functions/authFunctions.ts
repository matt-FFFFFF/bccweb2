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
import { randomUUID } from "crypto";
import type { User } from "@bccweb/types";
import { getBlobClient, readBlob, writeBlob } from "../lib/blob.js";
import { getOrCreateUser } from "../lib/auth.js";
import {
  AuthCredential,
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
  sendEmail,
  verificationEmailHtml,
  verificationEmailText,
  passwordResetEmailHtml,
  passwordResetEmailText,
} from "../lib/email.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(message: string): HttpResponseInit {
  return { status: 400, jsonBody: { error: message } };
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────

async function register(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  const { email, password } = body;
  if (!email || !EMAIL_REGEX.test(email)) {
    return badRequest("Invalid email address");
  }
  if (!password || password.length < 8) {
    return badRequest("Password must be at least 8 characters");
  }

  // Reject if email already registered
  const existing = await lookupUserByEmail(email);
  if (existing) {
    return {
      status: 409,
      jsonBody: { error: "An account with this email already exists" },
    };
  }

  const userId = randomUUID();

  // Write auth credential blob
  const credential: AuthCredential = {
    passwordHash: await hashPassword(password),
    emailVerified: false,
    createdAt: new Date().toISOString(),
  };
  await writeBlob(`auth/${userId}.json`, credential);

  // Create user record (pilot auto-link + user-index update)
  await getOrCreateUser(userId, email);

  // Generate verification token (24h TTL) and send email
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
    console.error("[auth/register] Failed to send verification email:", err);
  }

  return {
    status: 201,
    jsonBody: {
      message:
        "Registration successful. Please check your email to verify your account.",
    },
  };
}

// ─── GET /api/auth/verify ─────────────────────────────────────────────────────

async function verifyEmail(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const token = req.query.get("token");
  if (!token) return badRequest("Missing token");

  const result = await consumeShortLivedToken(token, "verify");
  if ("error" in result) {
    return { status: 400, jsonBody: { error: result.error } };
  }

  const credPath = `auth/${result.userId}.json`;
  let cred: AuthCredential;
  try {
    cred = await readBlob<AuthCredential>(getBlobClient(credPath));
  } catch {
    return { status: 400, jsonBody: { error: "Invalid token" } };
  }

  cred.emailVerified = true;
  await writeBlob(credPath, cred);

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
    cred = await readBlob<AuthCredential>(getBlobClient(`auth/${userId}.json`));
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

  let cred: AuthCredential;
  try {
    cred = await readBlob<AuthCredential>(
      getBlobClient(`auth/${userId}.json`)
    );
  } catch {
    return invalidCreds;
  }

  const passwordOk = await verifyPassword(password, cred.passwordHash);
  if (!passwordOk) return invalidCreds;

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

  const accessToken = signAccessToken(userId, email);
  const refreshToken = signRefreshToken(userId);

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
  let body: { refreshToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON");
  }

  if (!body.refreshToken) return badRequest("refreshToken is required");

  let userId: string;
  try {
    userId = verifyRefreshToken(body.refreshToken);
  } catch {
    return { status: 401, jsonBody: { error: "Invalid or expired refresh token" } };
  }

  // Confirm user still exists and get their email
  let user: User;
  try {
    user = await readBlob<User>(getBlobClient(`users/${userId}.json`));
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
    await readBlob<AuthCredential>(getBlobClient(`auth/${userId}.json`));
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

  const result = await consumeShortLivedToken(body.token, "reset");
  if ("error" in result) {
    return { status: 400, jsonBody: { error: result.error } };
  }

  const credPath = `auth/${result.userId}.json`;
  let cred: AuthCredential;
  try {
    cred = await readBlob<AuthCredential>(getBlobClient(credPath));
  } catch {
    return { status: 400, jsonBody: { error: "Invalid token" } };
  }

  cred.passwordHash = await hashPassword(body.newPassword);
  await writeBlob(credPath, cred);

  return {
    status: 200,
    jsonBody: { message: "Password reset successfully. You can now sign in." },
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("authRegister", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/register",
  handler: register,
});

app.http("authVerifyEmail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "auth/verify",
  handler: verifyEmail,
});

app.http("authResendVerification", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/resend-verification",
  handler: resendVerification,
});

app.http("authLogin", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/login",
  handler: login,
});

app.http("authRefresh", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/refresh",
  handler: refresh,
});

app.http("authForgotPassword", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/forgot-password",
  handler: forgotPassword,
});

app.http("authResetPassword", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/reset-password",
  handler: resetPassword,
});
