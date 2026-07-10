// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { BriefPdfStatus, Round, RoundBrief, RoundStatus } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";

import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withPrivateLease,
  withPrivateLeaseRenewing,
} from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import {
  briefHtmlBody,
  briefPlainText,
  getBriefRecipients,
  sendEmail,
} from "./email.js";

const MAX_PDF_ERROR_LENGTH = 200;
const REDACTED_ERROR_TEXT = "Brief PDF generation failed";
const SAFE_PDF_ERROR_CODE = /^[A-Za-z0-9_-]+$/;

interface CommitBriefPdfReadyOptions {
  expectAttemptId: string;
  siteName: string;
  date: string;
}

export interface SetBriefPdfStatusOptions {
  error?: string;
  expectAttemptId?: string;
  fromStatuses?: BriefPdfStatus[];
  newAttemptId?: string;
  requireRoundStatuses?: RoundStatus[];
}

export async function commitBriefPdfReady(
  roundId: string,
  pdfBuffer: Buffer,
  opts: CommitBriefPdfReadyOptions,
): Promise<{ committed: boolean }> {
  const roundPath = `rounds/${roundId}.json`;
  const pdfPath = `round-briefs/${roundId}.pdf`;

  return withPrivateLeaseRenewing(roundPath, async (leaseId) => {
    const round: Round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
    if (round.brief?.pdfAttemptId !== opts.expectAttemptId || round.brief?.pdfStatus === "ready") {
      return { committed: false };
    }

    const pdfBlobClient = getPrivateBlockBlobClient(pdfPath);
    await pdfBlobClient.upload(pdfBuffer, pdfBuffer.length, {
      blobHTTPHeaders: { blobContentType: "application/pdf" },
      metadata: { sitename: opts.siteName, date: opts.date },
    });

    round.brief = {
      ...round.brief,
      pdfStatus: "ready",
      pdfUpdatedAt: new Date().toISOString(),
    };
    await writePrivateJson(roundPath, RoundSchema, round, leaseId);
    return { committed: true };
  });
}

export async function sendBriefIfConfigured(
  brief: RoundBrief,
  pdfBuffer: Buffer | null,
): Promise<void> {
  const recipients = getBriefRecipients();
  if (recipients.length === 0) return;

  const dateDisplay = new Date(brief.date + "T00:00:00Z").toLocaleDateString(
    "en-GB",
    { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" },
  );

  await sendEmail({
    to: recipients,
    subject: `BCC Round Brief — ${brief.siteName} — ${dateDisplay}`,
    html: briefHtmlBody(brief.siteName, dateDisplay),
    text: briefPlainText(brief.siteName, dateDisplay),
    attachments: pdfBuffer
      ? [
          {
            name: `BCC-Brief-${brief.siteName.replace(/\s+/g, "-")}-${brief.date}.pdf`,
            contentType: "application/pdf",
            data: pdfBuffer,
          },
        ]
      : undefined,
  });
}

export async function setBriefPdfStatus(
  roundId: string,
  toStatus: BriefPdfStatus,
  opts: SetBriefPdfStatusOptions = {},
): Promise<{ updated: boolean; previousStatus?: BriefPdfStatus }> {
  const roundPath = `rounds/${roundId}.json`;

  return withPrivateLease(roundPath, async (leaseId) => {
    const round: Round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
    const previousStatus = round.brief?.pdfStatus;

    if (opts.newAttemptId !== undefined) {
      if (
        opts.requireRoundStatuses !== undefined &&
        !opts.requireRoundStatuses.includes(round.status)
      ) {
        return statusResult(false, previousStatus);
      }

      round.brief = {
        ...round.brief,
        pdfAttemptId: opts.newAttemptId,
        pdfStatus: toStatus,
        pdfUpdatedAt: new Date().toISOString(),
      };
      delete round.brief.pdfError;
      await writePrivateJson(roundPath, RoundSchema, round, leaseId);
      return statusResult(true, previousStatus);
    }

    if (opts.expectAttemptId !== undefined && opts.expectAttemptId !== round.brief?.pdfAttemptId) {
      return statusResult(false, previousStatus);
    }

    if (
      opts.fromStatuses !== undefined &&
      (previousStatus === undefined || !opts.fromStatuses.includes(previousStatus))
    ) {
      return statusResult(false, previousStatus);
    }

    round.brief = {
      ...round.brief,
      pdfStatus: toStatus,
      pdfUpdatedAt: new Date().toISOString(),
    };
    const pdfError = sanitizePdfError(opts.error);
    if (pdfError === undefined) {
      delete round.brief.pdfError;
    } else {
      round.brief.pdfError = pdfError;
    }
    await writePrivateJson(roundPath, RoundSchema, round, leaseId);
    return statusResult(true, previousStatus);
  });
}

function statusResult(
  updated: boolean,
  previousStatus: BriefPdfStatus | undefined,
): { updated: boolean; previousStatus?: BriefPdfStatus } {
  return previousStatus === undefined ? { updated } : { updated, previousStatus };
}

function sanitizePdfError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  if (error.length <= MAX_PDF_ERROR_LENGTH && SAFE_PDF_ERROR_CODE.test(error)) return error;
  return REDACTED_ERROR_TEXT;
}
