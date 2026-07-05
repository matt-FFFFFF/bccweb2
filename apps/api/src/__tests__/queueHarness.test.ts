import { app } from "@azure/functions";
import { describe, expect, test, vi } from "vitest";
import { invokeQueue } from "./helpers/api.js";
import { getRegisteredQueueHandler } from "./helpers/setup.js";

describe("storageQueue test harness", () => {
  test("registers a queue handler and invokes it with the parsed message + dequeueCount", async () => {
    const handler = vi.fn().mockResolvedValue("done");
    app.storageQueue("dummy", {
      queueName: "round-brief-pdf",
      connection: "AzureWebJobsStorage",
      handler,
    });

    expect(getRegisteredQueueHandler("dummy").queueName).toBe("round-brief-pdf");

    const message = { roundId: "r1", briefVersion: 1, pdfAttemptId: "a1" };
    const result = await invokeQueue("dummy", message, { dequeueCount: 3 });

    expect(result).toBe("done");
    expect(handler).toHaveBeenCalledTimes(1);

    const [passedMessage, ctx] = handler.mock.calls[0];
    expect(passedMessage).toEqual(message);
    expect(ctx.triggerMetadata.dequeueCount).toBe(3);
    expect(ctx.functionName).toBe("dummy");
  });

  test("defaults dequeueCount to 1 when not supplied", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    app.storageQueue("dummy-default", {
      queueName: "round-brief-pdf",
      connection: "AzureWebJobsStorage",
      handler,
    });

    await invokeQueue("dummy-default", { roundId: "r2" });

    expect(handler.mock.calls[0][1].triggerMetadata.dequeueCount).toBe(1);
  });

  test("throws 'not registered' for an unknown queue handler name", async () => {
    await expect(invokeQueue("missing", {})).rejects.toThrow(/not registered/);
  });
});
