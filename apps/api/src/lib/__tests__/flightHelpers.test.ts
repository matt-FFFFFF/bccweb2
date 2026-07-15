// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import * as blobJson from "../blobJson.js";
import { loadConfig } from "../flightHelpers.js";

afterEach(() => vi.restoreAllMocks());

describe("loadConfig", () => {
  it("returns schema defaults when config.json is absent from a virgin store", async () => {
    vi.spyOn(blobJson, "readJson").mockRejectedValueOnce(
      Object.assign(new Error("missing"), { statusCode: 404 }),
    );

    const config = await loadConfig();

    expect(config.flightDateValidationEnabled).toBe(true);
    expect(config.flightSignatureValidationEnabled).toBe(false);
  });

  it("propagates non-404 config read failures", async () => {
    const storageError = Object.assign(new Error("storage unavailable"), {
      statusCode: 500,
    });
    vi.spyOn(blobJson, "readJson").mockRejectedValueOnce(storageError);

    await expect(loadConfig()).rejects.toBe(storageError);
  });
});
