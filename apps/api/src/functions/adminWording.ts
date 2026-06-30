import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import {
  addWordingVersion,
  getActiveWording,
  getWording,
  listWordingVersions,
} from "../lib/signTofly/wording.js";

async function addSignToFlyWording(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await requireRole(req, "Admin");
  await mutationRateLimit(req, caller, "addSignToFlyWording", "standard");

  const body = await readWordingBody(req);
  const wording = await addWordingVersion({
    ...body,
    createdBy: caller.userId,
  });

  return { status: 201, jsonBody: wording };
}

async function getSignToFlyWordingVersion(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  await requireRole(req, "Admin");

  const versionParam = req.params["version"];
  const version = Number(versionParam);
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(400, "INVALID_WORDING_VERSION");
  }

  return { status: 200, jsonBody: await getWording(version) };
}

async function listSignToFlyWording(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  await requireRole(req, "Admin");

  return { status: 200, jsonBody: await listWordingVersions() };
}

async function getActiveSignToFlyWording(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  return { status: 200, jsonBody: await getActiveWording() };
}

async function readWordingBody(req: HttpRequest): Promise<{ markdown: string }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }

  const markdown = (body as { markdown?: unknown }).markdown;
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new HttpError(400, "MISSING_MARKDOWN");
  }

  return { markdown };
}

async function requireRole(req: HttpRequest, role: "Admin") {
  const caller = await getCallerIdentity(req);
  if (!caller) throw new HttpError(401, "UNAUTHORIZED");
  if (!caller.roles.includes(role)) throw new HttpError(403, "FORBIDDEN");
  return caller;
}

app.http("addSignToFlyWording", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/sign-to-fly/wording",
  handler: withErrorHandler(addSignToFlyWording),
});

app.http("listSignToFlyWording", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/sign-to-fly/wording",
  handler: withErrorHandler(listSignToFlyWording),
});

app.http("getSignToFlyWordingVersion", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/sign-to-fly/wording/{version}",
  handler: withErrorHandler(getSignToFlyWordingVersion),
});

app.http("getActiveSignToFlyWording", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sign-to-fly/wording/active",
  handler: withErrorHandler(getActiveSignToFlyWording),
});
