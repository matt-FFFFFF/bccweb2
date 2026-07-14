// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod/v4";

const DEFAULT_BASE_URL = "https://vali.fai-civl.org";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_IGC_BYTES = 3_000_000;

const FaiResponseSchema = z.looseObject({
  result: z.string().optional(),
  status: z.string().optional(),
  server: z.string().optional(),
  msg: z.string().optional(),
});

export type SignatureResult = "valid" | "invalid" | "unverified";

export async function validateIgcSignature(
  buffer: Buffer,
  filename: string,
): Promise<{
  signature: SignatureResult;
  faiStatus?: string;
  faiServer?: string;
  faiMsg?: string;
}> {
  if (process.env["FAI_VALI_ENABLED"] === "false") {
    return { signature: "unverified", faiStatus: "DISABLED" };
  }
  if (buffer.length > MAX_IGC_BYTES) {
    return { signature: "unverified", faiStatus: "TOO_LARGE" };
  }

  try {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], {
      type: "application/octet-stream",
    });
    formData.append("igcfile", blob, filename);
    const baseUrl = process.env["FAI_VALI_BASE_URL"] ?? DEFAULT_BASE_URL;
    const timeoutMs = Number(
      process.env["FAI_VALI_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS,
    );
    const response = await fetch(`${baseUrl}/api/vali/json`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { signature: "unverified", faiStatus: `HTTP_${response.status}` };
    }

    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch (error: unknown) {
      return {
        signature: "unverified",
        faiStatus: error instanceof SyntaxError ? "NON_JSON" : "ERROR",
      };
    }

    const parsed = FaiResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      return { signature: "unverified", faiStatus: "INVALID_RESPONSE" };
    }
    const signature: SignatureResult = parsed.data.result === "PASSED"
      ? "valid"
      : parsed.data.result === "FAILED"
        ? "invalid"
        : "unverified";
    return {
      signature,
      ...(parsed.data.status === undefined ? {} : { faiStatus: parsed.data.status }),
      ...(parsed.data.server === undefined ? {} : { faiServer: parsed.data.server }),
      ...(parsed.data.msg === undefined ? {} : { faiMsg: parsed.data.msg }),
    };
  } catch (error: unknown) {
    const timedOut = error instanceof DOMException
      && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      signature: "unverified",
      faiStatus: timedOut ? "TIMEOUT" : "ERROR",
    };
  }
}
