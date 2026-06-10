import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getCallerIdentity, forbiddenResponse, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import {
  addWordingVersion,
  getActiveWording,
  getWording,
} from "../lib/signTofly/wording.js";

async function addSignToFlyWording(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

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
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  const versionParam = req.params["version"];
  const version = Number(versionParam);
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(400, "INVALID_WORDING_VERSION");
  }

  return { status: 200, jsonBody: await getWording(version) };
}

async function getActiveSignToFlyWording(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  return { status: 200, jsonBody: await getActiveWording() };
}

async function readWordingBody(req: HttpRequest): Promise<{ html: string; plainText: string }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }

  const html = (body as { html?: unknown }).html;
  const plainText = (body as { plainText?: unknown }).plainText;
  if (typeof html !== "string" || html.trim() === "") {
    throw new HttpError(400, "MISSING_HTML");
  }
  if (typeof plainText !== "string" || plainText.trim() === "") {
    throw new HttpError(400, "MISSING_PLAIN_TEXT");
  }

  return { html, plainText };
}

app.http("addSignToFlyWording", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/sign-to-fly/wording",
  handler: withErrorHandler(addSignToFlyWording),
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
