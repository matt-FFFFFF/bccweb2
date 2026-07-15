// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { QueueClient } from "@azure/storage-queue";
import type { FlightValidation, IgcValidationJob } from "@bccweb/types";
import { afterEach, describe, expect, test } from "vitest";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  acquireIgcValidationGuard,
  assertFaiValiTimeoutWithinGuard,
  deleteValidationResult,
  enqueueIgcValidation,
  IGC_VALIDATION_QUEUE_NAME,
  paceBeforeFaiCall,
  readValidationResult,
  releaseIgcValidationGuard,
  writeValidationResult,
} from "../igcValidationJob.js";

const queueConnectionString = process.env["AzureWebJobsStorage"];
if (!queueConnectionString) {
  throw new Error("AzureWebJobsStorage missing in test setup");
}

const queueClient = new QueueClient(
  queueConnectionString,
  IGC_VALIDATION_QUEUE_NAME,
);

function job(): IgcValidationJob {
  return {
    roundId: randomUUID(),
    teamId: randomUUID(),
    place: 3,
    flightId: randomUUID(),
    validationAttemptId: randomUUID(),
  };
}

describe("IGC validation queue", () => {
  afterEach(async () => {
    await queueClient.deleteIfExists();
  });

  test("enqueues exact base64 JSON using AzureWebJobsStorage", async () => {
    // Given
    await queueClient.createIfNotExists();
    const expected = job();

    // When
    await enqueueIgcValidation(expected);

    // Then
    const response = await queueClient.receiveMessages({ numberOfMessages: 1 });
    const message = response.receivedMessageItems[0];
    expect(message).toBeDefined();
    expect(message?.messageText).toBe(
      Buffer.from(JSON.stringify(expected)).toString("base64"),
    );
    expect(
      JSON.parse(Buffer.from(message?.messageText ?? "", "base64").toString("utf8")),
    ).toEqual(expected);
  });

  test("rejects an extra key before sending", async () => {
    // Given
    await queueClient.createIfNotExists();
    const invalidJob = { ...job(), pilotEmail: "pilot@example.test" };

    // When
    const enqueue = enqueueIgcValidation(invalidJob);

    // Then
    await expect(enqueue).rejects.toThrow();
    expect((await queueClient.peekMessages()).peekedMessageItems).toHaveLength(0);
  });
});

describe("IGC validation guard", () => {
  test("rejects a FAI timeout that can outlive the guard lease budget", () => {
    // Given
    const previousTimeout = process.env["FAI_VALI_TIMEOUT_MS"];
    process.env["FAI_VALI_TIMEOUT_MS"] = "60000";

    try {
      // When
      const validateTimeout = () => assertFaiValiTimeoutWithinGuard();

      // Then
      expect(validateTimeout).toThrow("FAI_VALI_TIMEOUT_MS must be at most 50000ms");
    } finally {
      if (previousTimeout === undefined) delete process.env["FAI_VALI_TIMEOUT_MS"];
      else process.env["FAI_VALI_TIMEOUT_MS"] = previousTimeout;
    }
  });

  test("acquires and releases a real finite lease", async () => {
    // Given
    const guard = await acquireIgcValidationGuard();

    // When
    await releaseIgcValidationGuard(guard.leaseId);

    // Then
    const properties = await getPrivateContainer()
      .getBlobClient("igc-validation/active.json")
      .getProperties();
    expect(properties.leaseState).toBe("available");
  });

  test("denies a second host while the first lease is held", async () => {
    // Given
    const guard = await acquireIgcValidationGuard();

    try {
      // When
      const contender = acquireIgcValidationGuard();

      // Then
      await expect(contender).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await releaseIgcValidationGuard(guard.leaseId);
    }
  });

  test("releases in finally after failure so the next worker can acquire", async () => {
    // Given
    const guard = await acquireIgcValidationGuard();

    // When
    await expect((async () => {
      try {
        throw new Error("simulated FAI callback failure");
      } finally {
        await releaseIgcValidationGuard(guard.leaseId);
      }
    })()).rejects.toThrow("simulated FAI callback failure");

    // Then
    const nextGuard = await acquireIgcValidationGuard();
    await releaseIgcValidationGuard(nextGuard.leaseId);
  });

  test("persists start times and spaces calls by at least two seconds", async () => {
    // Given
    const firstGuard = await acquireIgcValidationGuard();
    const firstStartedAt = await paceBeforeFaiCall(firstGuard.leaseId);
    await releaseIgcValidationGuard(firstGuard.leaseId);

    // When
    const secondGuard = await acquireIgcValidationGuard();
    const secondStartedAt = await paceBeforeFaiCall(secondGuard.leaseId);
    await releaseIgcValidationGuard(secondGuard.leaseId);

    // Then
    expect(secondStartedAt.getTime() - firstStartedAt.getTime()).toBeGreaterThanOrEqual(
      2_000,
    );
    const properties = await getPrivateContainer()
      .getBlobClient("igc-validation/active.json")
      .getProperties();
    expect(properties.metadata?.["lastcallstartedat"]).toBe(
      secondStartedAt.toISOString(),
    );
  });
});

describe("IGC validation result records", () => {
  test("round-trips a create-only durable result", async () => {
    // Given
    const attemptId = randomUUID();
    const result: FlightValidation = {
      signature: "valid",
      checkedAt: new Date().toISOString(),
      validationAttemptId: attemptId,
      faiStatus: "PASSED",
      faiServer: "vali-1",
      faiMsg: "G record valid",
    };

    // When
    await writeValidationResult(attemptId, result);

    // Then
    expect(await readValidationResult(attemptId)).toEqual(result);
    await expect(
      writeValidationResult(attemptId, { ...result, signature: "invalid" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await readValidationResult(attemptId)).toEqual(result);
  });

  test("permits explicit post-commit garbage collection", async () => {
    // Given
    const attemptId = randomUUID();
    await writeValidationResult(attemptId, {
      signature: "unverified",
      faiStatus: "TIMEOUT",
    });

    // When
    await deleteValidationResult(attemptId);

    // Then
    expect(await readValidationResult(attemptId)).toBeNull();
  });
});
