// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateIgcSignature } from "../faiVali.js";

const fetchMock = vi.fn<typeof fetch>();
const igcBuffer = Buffer.from("AXXX\nGsignature");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateIgcSignature", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env["FAI_VALI_BASE_URL"] = "https://vali.example.test";
    process.env["FAI_VALI_TIMEOUT_MS"] = "1234";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["FAI_VALI_ENABLED"];
    delete process.env["FAI_VALI_BASE_URL"];
    delete process.env["FAI_VALI_TIMEOUT_MS"];
  });

  it("returns valid and sends the IGC multipart upload when FAI passes it", async () => {
    // Given
    fetchMock.mockResolvedValue(jsonResponse({
      result: "PASSED",
      status: "G-Record valid",
      server: "vali-1",
      msg: "Signature verified",
    }));

    // When
    const result = await validateIgcSignature(igcBuffer, "flight.igc");

    // Then
    expect(result).toEqual({
      signature: "valid",
      faiStatus: "G-Record valid",
      faiServer: "vali-1",
      faiMsg: "Signature verified",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://vali.example.test/api/vali/json");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeInstanceOf(FormData);
    const upload = init?.body instanceof FormData
      ? init.body.get("igcfile")
      : null;
    expect(upload).toBeInstanceOf(File);
    if (!(upload instanceof File)) throw new Error("Expected igcfile to be a File");
    expect(upload.name).toBe("flight.igc");
    expect(upload.type).toBe("application/octet-stream");
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(igcBuffer);
  });

  it("returns invalid when FAI fails the signature", async () => {
    // Given
    fetchMock.mockResolvedValue(jsonResponse({ result: "FAILED", status: "BAD_G_RECORD" }));

    // When
    const result = await validateIgcSignature(igcBuffer, "flight.igc");

    // Then
    expect(result).toEqual({ signature: "invalid", faiStatus: "BAD_G_RECORD" });
  });

  it.each(["ERROR", "ERR_UNSUPPORTED"])(
    "returns unverified when FAI reports %s",
    async (faiResult) => {
      // Given
      fetchMock.mockResolvedValue(jsonResponse({ result: faiResult, status: faiResult }));

      // When
      const result = await validateIgcSignature(igcBuffer, "flight.igc");

      // Then
      expect(result).toEqual({ signature: "unverified", faiStatus: faiResult });
    },
  );

  it("returns unverified when FAI responds with HTTP 500", async () => {
    // Given
    fetchMock.mockResolvedValue(new Response("upstream failure", { status: 500 }));

    // When
    const result = await validateIgcSignature(igcBuffer, "flight.igc");

    // Then
    expect(result).toEqual({ signature: "unverified", faiStatus: "HTTP_500" });
  });

  it("returns unverified when FAI returns a non-JSON body", async () => {
    // Given
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));

    // When
    const result = await validateIgcSignature(igcBuffer, "flight.igc");

    // Then
    expect(result).toEqual({ signature: "unverified", faiStatus: "NON_JSON" });
  });

  it("resolves unverified when fetch rejects", async () => {
    // Given
    fetchMock.mockRejectedValue(new TypeError("network unavailable"));

    // When
    const resultPromise = validateIgcSignature(igcBuffer, "flight.igc");

    // Then
    await expect(resultPromise).resolves.toEqual({
      signature: "unverified",
      faiStatus: "ERROR",
    });
  });

  it("resolves unverified with TIMEOUT when fetch aborts", async () => {
    // Given
    fetchMock.mockRejectedValue(new DOMException("timed out", "AbortError"));

    // When
    const resultPromise = validateIgcSignature(igcBuffer, "flight.igc");

    // Then
    await expect(resultPromise).resolves.toEqual({
      signature: "unverified",
      faiStatus: "TIMEOUT",
    });
  });

  it("does not fetch when the IGC exceeds 3 MB", async () => {
    // Given
    const oversizedIgc = Buffer.alloc(3_000_001);

    // When
    const result = await validateIgcSignature(oversizedIgc, "large.igc");

    // Then
    expect(result).toEqual({ signature: "unverified", faiStatus: "TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when FAI validation is disabled", async () => {
    // Given
    process.env["FAI_VALI_ENABLED"] = "false";

    // When
    const result = await validateIgcSignature(igcBuffer, "flight.igc");

    // Then
    expect(result).toEqual({ signature: "unverified", faiStatus: "DISABLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
