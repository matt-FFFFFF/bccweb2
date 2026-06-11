/**
 * Setup file for API integration tests.
 *
 * - Sets environment variables needed by the app code
 * - Mocks @azure/functions to capture handler registrations
 * - Mocks external services (email, pdf, puretrack) to prevent real calls
 */

import { beforeEach, vi } from "vitest";
import { resetAllBuckets } from "../../lib/rateLimit.js";

// ─── Environment variables ────────────────────────────────────────────────────

const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

process.env["BLOB_CONNECTION_STRING"] ??= AZURITE_CONNECTION_STRING;
process.env["JWT_SECRET"] ??= "test-jwt-secret-for-vitest-at-least-32-chars-long";
process.env["APP_URL"] ??= "http://localhost:5173";

// ─── Mock @azure/functions ────────────────────────────────────────────────────

// Handler registry — captured via the mocked app.http()
const _handlers = new Map<
  string,
  { methods: string[]; route: string; handler: Function }
>();

vi.mock("@azure/functions", () => ({
  app: {
    http: vi.fn(
      (
        name: string,
        options: {
          methods: string[];
          authLevel: string;
          route: string;
          handler: Function;
        },
      ) => {
        _handlers.set(name, {
          methods: options.methods,
          route: options.route,
          handler: options.handler,
        });
      },
    ),
  },
}));

// Export the handler registry so tests can invoke handlers
export function getRegisteredHandler(name: string) {
  return _handlers.get(name);
}

export function getRegisteredHandlers() {
  return _handlers;
}

// ─── Mock external services ───────────────────────────────────────────────────

// Mock email module — prevent real ACS email calls
vi.mock("../../lib/email.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  verificationEmailHtml: vi.fn().mockReturnValue("<p>verify</p>"),
  verificationEmailText: vi.fn().mockReturnValue("verify"),
  passwordResetEmailHtml: vi.fn().mockReturnValue("<p>reset</p>"),
  passwordResetEmailText: vi.fn().mockReturnValue("reset"),
  getBriefRecipients: vi.fn().mockReturnValue([]),
}));

// ─── Email mock helpers ───────────────────────────────────────────────────────
//
// vi.mock above is hoisted by Vitest above this static import, so the `sendEmail`
// imported here is the mocked function. Do NOT reorder.

import { sendEmail } from "../../lib/email.js";

export interface CapturedEmail {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
}

export function getSentEmails(): CapturedEmail[] {
  const calls = vi.mocked(sendEmail).mock.calls as Array<[CapturedEmail]>;
  return calls.map(([opts]) => opts);
}

export function clearSentEmails(): void {
  vi.mocked(sendEmail).mockClear();
}

beforeEach(() => resetAllBuckets());
