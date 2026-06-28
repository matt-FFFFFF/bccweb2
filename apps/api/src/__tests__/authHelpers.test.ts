import { describe, test, expect } from "vitest";
import crypto from "crypto";
import {
  generateShortLivedToken,
  consumeShortLivedToken,
  TokenNotFoundError,
  TokenExpiredError,
  TokenAlreadyConsumedError,
} from "../lib/authHelpers.js";
import type { AuthToken } from "../lib/authHelpers.js";
import { getPrivateContainer } from "./helpers/azurite.js";

describe("consumeShortLivedToken", () => {
  test("happy: first consume returns userId, second consume throws TokenAlreadyConsumedError", async () => {
    const userId = crypto.randomUUID();
    const raw = await generateShortLivedToken(userId, "verify", 24);

    const result = await consumeShortLivedToken(raw, "verify");
    expect(result).toEqual({ userId });

    await expect(consumeShortLivedToken(raw, "verify")).rejects.toBeInstanceOf(
      TokenAlreadyConsumedError
    );
  });

  test("expired token throws TokenExpiredError without deleting blob", async () => {
    const userId = crypto.randomUUID();
    const raw = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");

    const tokenDoc: AuthToken = {
      userId,
      type: "verify",
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    };

    const blobClient = getPrivateContainer().getBlockBlobClient(`auth/tokens/${hash}.json`);
    const content = JSON.stringify(tokenDoc);
    await blobClient.upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });

    await expect(consumeShortLivedToken(raw, "verify")).rejects.toBeInstanceOf(
      TokenExpiredError
    );

    expect(await blobClient.exists()).toBe(true);
  });

  test("missing token throws TokenNotFoundError", async () => {
    const raw = crypto.randomBytes(32).toString("hex");

    await expect(consumeShortLivedToken(raw, "verify")).rejects.toBeInstanceOf(
      TokenNotFoundError
    );
  });

  test("concurrent: 10 parallel consumes -> exactly 1 succeeds, 9 throw TokenAlreadyConsumedError", async () => {
    const userId = crypto.randomUUID();
    const raw = await generateShortLivedToken(userId, "verify", 24);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => consumeShortLivedToken(raw, "verify"))
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(
      (fulfilled[0] as PromiseFulfilledResult<{ userId: string }>).value
    ).toEqual({ userId });

    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect((r).reason).toBeInstanceOf(
        TokenAlreadyConsumedError
      );
    }
  });
});
