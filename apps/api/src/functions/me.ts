import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { withErrorHandler } from "../lib/http.js";

async function meHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const identity = await getCallerIdentity(req);

  if (!identity) {
    return unauthorizedResponse();
  }

  return {
    status: 200,
    jsonBody: identity,
  };
}

app.http("me", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "me",
  handler: withErrorHandler(meHandler),
});
