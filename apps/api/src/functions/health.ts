// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { withErrorHandler } from "../lib/http.js";

// eslint-disable-next-line @typescript-eslint/require-await -- handler must satisfy HttpHandler = (req, ctx) => Promise<HttpResponseInit> (withErrorHandler awaits it); the body is static with nothing to await.
async function healthHandler(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: { status: "ok", timestamp: new Date().toISOString() },
  };
}

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: withErrorHandler(healthHandler),
});
