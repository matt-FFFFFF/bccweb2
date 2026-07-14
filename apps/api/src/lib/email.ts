// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * ACS Email wrapper — Phase 4
 *
 * Sends transactional emails via Azure Communication Services Email.
 * Requires environment variables:
 *   ACS_CONNECTION_STRING — from the azurerm_communication_service resource
 *   ACS_SENDER_ADDRESS    — e.g. "noreply@yourdomain.com"
 */

import { EmailClient } from "@azure/communication-email";

// ─── Client singleton ─────────────────────────────────────────────────────────

let _emailClient: EmailClient | null = null;

function getEmailClient(): EmailClient {
  if (_emailClient) return _emailClient;

  const connectionString = process.env["ACS_CONNECTION_STRING"];
  if (!connectionString) {
    throw new Error("ACS_CONNECTION_STRING environment variable is not set");
  }

  _emailClient = new EmailClient(connectionString);
  return _emailClient;
}

function getSenderAddress(): string {
  const addr = process.env["ACS_SENDER_ADDRESS"];
  if (!addr) throw new Error("ACS_SENDER_ADDRESS environment variable is not set");
  return addr;
}

// ─── Send round brief ─────────────────────────────────────────────────────────

export interface EmailAttachment {
  name: string;
  contentType: string;
  /** Raw bytes — will be Base64-encoded for the ACS payload */
  data: Buffer;
}

export interface SendEmailOptions {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

/**
 * Send an email via ACS. Waits for the send to be accepted (not delivered).
 * Throws if ACS returns an error status.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  if (opts.to.length === 0) {
    console.warn("[email] No recipients — skipping send");
    return;
  }

  const client = getEmailClient();
  const sender = getSenderAddress();

  const message = {
    senderAddress: sender,
    recipients: {
      to: opts.to.map((address) => ({ address })),
    },
    content: {
      subject: opts.subject,
      html: opts.html,
      plainText: opts.text,
    },
    attachments: opts.attachments?.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      contentInBase64: a.data.toString("base64"),
    })),
  };

  const poller = await client.beginSend(message);
  const result = await poller.pollUntilDone();

  if (result.status === "Failed") {
    throw new Error(
      `ACS Email send failed: ${result.error?.message ?? "unknown error"}`
    );
  }
}

// ─── Helpers: email templates ─────────────────────────────────────────────────

// SECURITY: values interpolated into HTML email bodies (site/round names, verify
// and reset URLs) are escaped to prevent HTML/attribute injection into outbound
// mail. Plain-text templates do not need this.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain-text fallback body for the round brief email */
export function briefPlainText(siteName: string, date: string): string {
  return [
    `BCC Round Brief — ${siteName} — ${date}`,
    "",
    "Please find the round brief attached as a PDF.",
    "",
    "This email was sent automatically by the BCC competition management system.",
  ].join("\n");
}

/** HTML body for the round brief email */
export function briefHtmlBody(siteName: string, date: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>BCC Round Brief</title></head>
<body style="font-family:sans-serif;color:#222;max-width:600px;margin:0 auto;padding:1rem">
  <h2 style="color:#1a4fa0">BCC Round Brief</h2>
  <p><strong>${escapeHtml(siteName)}</strong> &mdash; ${escapeHtml(date)}</p>
  <p>Please find the round brief attached as a PDF.</p>
  <hr style="border:none;border-top:1px solid #ddd;margin:1.5rem 0">
  <p style="font-size:0.85em;color:#888">
    This email was sent automatically by the BCC competition management system.
  </p>
</body>
</html>`;
}

// ─── Auth email templates — Phase 5 ──────────────────────────────────────────

/** HTML email for account verification */
export function verificationEmailHtml(verifyUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Verify your BCC account</title></head>
<body style="font-family:sans-serif;color:#222;max-width:600px;margin:0 auto;padding:1rem">
  <h2 style="color:#1a4fa0">Verify your BCC account</h2>
  <p>Thank you for registering. Please click the button below to verify your email address.</p>
  <p style="margin:1.5rem 0">
    <a href="${escapeHtml(verifyUrl)}" style="background:#1a4fa0;color:#fff;padding:0.6rem 1.2rem;border-radius:0.3rem;text-decoration:none;font-weight:bold">Verify email address</a>
  </p>
  <p style="color:#666;font-size:0.9em">This link expires in 24 hours. If you did not create an account, you can ignore this email.</p>
  <p style="color:#888;font-size:0.85em">Or copy this link: <a href="${escapeHtml(verifyUrl)}" style="color:#1a4fa0">${escapeHtml(verifyUrl)}</a></p>
  <hr style="border:none;border-top:1px solid #ddd;margin:1.5rem 0">
  <p style="font-size:0.85em;color:#888">This email was sent automatically by the BCC competition management system.</p>
</body>
</html>`;
}

/** Plain-text fallback for account verification */
export function verificationEmailText(verifyUrl: string): string {
  return [
    "Verify your BCC account",
    "",
    "Thank you for registering. Please visit the link below to verify your email address.",
    "",
    verifyUrl,
    "",
    "This link expires in 24 hours. If you did not create an account, you can ignore this email.",
    "",
    "This email was sent automatically by the BCC competition management system.",
  ].join("\n");
}

/** HTML email for password reset */
export function passwordResetEmailHtml(resetUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Reset your BCC password</title></head>
<body style="font-family:sans-serif;color:#222;max-width:600px;margin:0 auto;padding:1rem">
  <h2 style="color:#1a4fa0">Reset your BCC password</h2>
  <p>We received a request to reset the password for your BCC account.</p>
  <p style="margin:1.5rem 0">
    <a href="${escapeHtml(resetUrl)}" style="background:#1a4fa0;color:#fff;padding:0.6rem 1.2rem;border-radius:0.3rem;text-decoration:none;font-weight:bold">Reset password</a>
  </p>
  <p style="color:#666;font-size:0.9em">This link expires in 1 hour. If you did not request a password reset, you can ignore this email.</p>
  <p style="color:#888;font-size:0.85em">Or copy this link: <a href="${escapeHtml(resetUrl)}" style="color:#1a4fa0">${escapeHtml(resetUrl)}</a></p>
  <hr style="border:none;border-top:1px solid #ddd;margin:1.5rem 0">
  <p style="font-size:0.85em;color:#888">This email was sent automatically by the BCC competition management system.</p>
</body>
</html>`;
}

/** Plain-text fallback for password reset */
export function passwordResetEmailText(resetUrl: string): string {
  return [
    "Reset your BCC password",
    "",
    "We received a request to reset the password for your BCC account. Visit the link below to set a new password.",
    "",
    resetUrl,
    "",
    "This link expires in 1 hour. If you did not request a password reset, you can ignore this email.",
    "",
    "This email was sent automatically by the BCC competition management system.",
  ].join("\n");
}
