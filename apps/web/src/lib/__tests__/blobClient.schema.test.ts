// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as z from "zod/v4";
import { readPublicBlob } from "../../lib/blobClient.js";

const RoundSummarySchema = z.object({
  id: z.string(),
  date: z.string(),
});

describe("Task 43: readPublicBlob schema validation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fetchSpy?.mockRestore?.();
    vi.unstubAllGlobals();
  });

  it("warns in DEV when blob shape mismatches and STILL returns raw cast", async () => {
    const bad = [{ id: 123, date: null, extra: "trash" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(bad),
    }));

    const result = await readPublicBlob<unknown[]>("rounds.json", z.array(RoundSummarySchema));

    expect(warnSpy).toHaveBeenCalledWith(
      "blob shape mismatch",
      expect.objectContaining({
        path: "rounds.json",
        issues: expect.any(Array),
      })
    );
    expect(result).toEqual(bad);
  });

  it("returns parsed value silently on success", async () => {
    const good = [{ id: "abc", date: "2025-01-01" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(good),
    }));

    const result = await readPublicBlob<typeof good>("rounds.json", z.array(RoundSummarySchema));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual(good);
  });

  it("returns raw cast (no warn) when schema is omitted (incremental adoption)", async () => {
    const raw = { wild: "shape" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(raw),
    }));

    const result = await readPublicBlob<unknown>("any.json");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual(raw);
  });
});
