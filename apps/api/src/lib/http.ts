import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

export class HttpError extends Error {
  public headers?: Record<string, string>;

  constructor(
    public status: number,
    public code: string,
    public detail?: string,
    headers?: Record<string, string>
  ) {
    super(detail ?? code);
    this.name = "HttpError";
    if (headers) this.headers = headers;
  }
}

export type HttpHandler = (
  req: HttpRequest,
  ctx: InvocationContext
) => Promise<HttpResponseInit>;

export function shortErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 422:
      return "Unprocessable Entity";
    case 423:
      return "Locked";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    default:
      return "Error";
  }
}

function errorCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 423:
      return "LOCKED";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL" : "ERROR";
  }
}

export function withErrorHandler(handler: HttpHandler): HttpHandler {
  return async (req, ctx) => {
    try {
      const response = await handler(req, ctx);
      if (response.status !== undefined && response.status >= 400) {
        const body = response.jsonBody as { code?: string; detail?: string } | undefined;
        return {
          status: response.status,
          jsonBody: {
            error: shortErrorMessage(response.status),
            code: body?.code ?? errorCodeForStatus(response.status),
            requestId: ctx.invocationId,
            ...(body?.detail ? { detail: body.detail } : {}),
          },
        };
      }
      return response;
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          status: err.status,
          ...(err.headers ? { headers: err.headers } : {}),
          jsonBody: {
            error: shortErrorMessage(err.status),
            code: err.code,
            requestId: ctx.invocationId,
            ...(err.detail ? { detail: err.detail } : {}),
          },
        };
      }

      ctx.error(err instanceof Error ? err.stack ?? err.message : err);
      return {
        status: 500,
        jsonBody: {
          error: "Internal server error",
          code: "INTERNAL",
          requestId: ctx.invocationId,
        },
      };
    }
  };
}
