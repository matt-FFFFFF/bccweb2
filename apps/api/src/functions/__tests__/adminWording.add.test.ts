import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpResponseInit } from "@azure/functions";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { MockHttpRequest } from "../../__tests__/helpers/api.js";
import { bootstrapAdmin } from "../../__tests__/helpers/seed.js";
import { getPrivateBlockBlobClient } from "../../lib/blob.js";
import { getActiveWording } from "../../lib/signTofly/wording.js";

import "../adminWording.js";

// Stability lock shared with the wording-registry unit test: sha256 of the raw
// markdown source bytes. POST {markdown} must persist exactly this hash.
const FIXED_MARKDOWN =
  "# Sign to Fly\n\nBy clicking **Sign to Fly**, you confirm you have received and understood a full brief for this round.\n";
const FIXED_MARKDOWN_SHA256 =
  "6dda7f5c90373fc53e91f9c9a65dfd301e3d956ba6950355597d430309744bfe";

describe("admin sign-to-fly wording add endpoint", () => {
  beforeEach(async () => {
    await Promise.all([
      getPrivateBlockBlobClient("sign-to-fly/wording/active.json").deleteIfExists(),
      ...[1, 2, 3, 4].map((version) =>
        getPrivateBlockBlobClient(`sign-to-fly/wording/${version}.json`).deleteIfExists(),
      ),
    ]);
  });

  it("stores raw markdown, hashes it, and getActiveWording returns the markdown", async () => {
    const res = await invokeAdd({ markdown: FIXED_MARKDOWN });

    expect(res.status).toBe(201);
    const wording = res.jsonBody as Record<string, unknown>;
    expect(wording.version).toBe(1);
    expect(wording.markdown).toBe(FIXED_MARKDOWN);
    expect(wording.hash).toBe(FIXED_MARKDOWN_SHA256);
    expect(wording.hash).toBe(hashMarkdown(FIXED_MARKDOWN));
    expect(wording).not.toHaveProperty("html");
    expect(wording).not.toHaveProperty("plainText");

    const active = await getActiveWording();
    expect(active.markdown).toBe(FIXED_MARKDOWN);
    expect(active.hash).toBe(FIXED_MARKDOWN_SHA256);
  });

  it("rejects empty markdown with 400 MISSING_MARKDOWN", async () => {
    const res = await invokeAdd({ markdown: "   " });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("MISSING_MARKDOWN");
  });

  it("rejects missing markdown with 400 MISSING_MARKDOWN", async () => {
    const res = await invokeAdd({});

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("MISSING_MARKDOWN");
  });

  it("rejects non-string markdown with 400 MISSING_MARKDOWN", async () => {
    const res = await invokeAdd({ markdown: 123 });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("MISSING_MARKDOWN");
  });
});

async function invokeAdd(body: unknown): Promise<HttpResponseInit> {
  const entry = getRegisteredHandler("addSignToFlyWording");
  if (!entry) throw new Error("addSignToFlyWording handler not registered");

  const { token } = await bootstrapAdmin();
  return entry.handler(
    new MockHttpRequest({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
    { functionName: "addSignToFlyWording" },
  );
}

function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}
