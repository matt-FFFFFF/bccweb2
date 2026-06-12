import { describe, expect, test, vi } from "vitest";
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { BlobShapeError, HttpError, shortErrorMessage, withErrorHandler } from "../http.js";

function makeCtx(): InvocationContext {
  return {
    invocationId: "req-123",
    functionName: "testFn",
    extraInputs: { get: vi.fn(), set: vi.fn() } as never,
    extraOutputs: { set: vi.fn() } as never,
    log: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    options: {} as never,
  } as InvocationContext;
}

function makeReq(): HttpRequest {
  return {
    headers: new Headers(),
    params: {},
    query: new URLSearchParams(),
    method: "GET",
    url: "http://localhost",
    json: vi.fn(),
    text: vi.fn(),
  } as never;
}

describe("shortErrorMessage", () => {
  test("maps known statuses and defaults to Error", () => {
    expect(shortErrorMessage(400)).toBe("Bad Request");
    expect(shortErrorMessage(401)).toBe("Unauthorized");
    expect(shortErrorMessage(403)).toBe("Forbidden");
    expect(shortErrorMessage(404)).toBe("Not Found");
    expect(shortErrorMessage(409)).toBe("Conflict");
    expect(shortErrorMessage(422)).toBe("Unprocessable Entity");
    expect(shortErrorMessage(423)).toBe("Locked");
    expect(shortErrorMessage(429)).toBe("Too Many Requests");
    expect(shortErrorMessage(500)).toBe("Internal Server Error");
    expect(shortErrorMessage(418)).toBe("Error");
  });
});

describe("withErrorHandler", () => {
  test("HttpError(400, MISSING_X, x required) -> body shape", async () => {
    const handler = withErrorHandler(async () => {
      throw new HttpError(400, "MISSING_X", "x required");
    });

    const res = await handler(makeReq(), makeCtx());
    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({
      error: "Bad Request",
      code: "MISSING_X",
      requestId: "req-123",
      detail: "x required",
    });
  });

  test("HttpError(429, RATE_LIMITED, ...) preserves status", async () => {
    const handler = withErrorHandler(async () => {
      throw new HttpError(429, "RATE_LIMITED", "slow down");
    });

    const res = await handler(makeReq(), makeCtx());
    expect(res.status).toBe(429);
    expect((res.jsonBody as { code: string }).code).toBe("RATE_LIMITED");
  });

  test("unhandled throw -> 500 body and ctx.error called", async () => {
    const ctx = makeCtx();
    const handler = withErrorHandler(async () => {
      throw new Error("boom");
    });

    const res = await handler(makeReq(), ctx);
    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual({
      error: "Internal server error",
      code: "INTERNAL",
      requestId: "req-123",
    });
    expect(ctx.error).toHaveBeenCalledTimes(1);
  });

  test("BlobShapeError -> 500 DATA_SHAPE_INVALID body and ctx.error called with issues", async () => {
    const ctx = makeCtx();
    const issues = [{ path: ["x"], message: "y" }];
    const handler = withErrorHandler(async () => {
      throw new BlobShapeError("foo/bar.json", "FooSchema", issues);
    });

    const res = await handler(makeReq(), ctx);
    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual({
      error: "DATA_SHAPE_INVALID",
      path: "foo/bar.json",
      schema: "FooSchema",
    });
    expect(res.jsonBody).not.toHaveProperty("issues");
    expect(ctx.error).toHaveBeenCalledTimes(1);
    expect(ctx.error).toHaveBeenCalledWith("Blob shape invalid at foo/bar.json (schema: FooSchema)", issues);
  });
});
