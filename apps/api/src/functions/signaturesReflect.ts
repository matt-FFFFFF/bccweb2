import { app, type InvocationContext } from "@azure/functions";

import { SignToFlyReflectJobSchema } from "../lib/queue.js";
import { reflectRoundSignToFly } from "../lib/signTofly/reflect.js";
import { getTelemetryClient } from "../lib/telemetry.js";
import { redactObject } from "../lib/telemetryRedactor.js";

const MAX_DEQUEUE = 5;

type QueueMessage = unknown;

export function parseReflectMessage(message: QueueMessage) {
  const raw: unknown = typeof message === "string" ? JSON.parse(message) : message;
  return SignToFlyReflectJobSchema.parse(raw);
}

export async function handleSignToFlyReflectJob(
  message: QueueMessage,
  ctx: InvocationContext,
): Promise<void> {
  const { roundId } = parseReflectMessage(message);

  try {
    await reflectRoundSignToFly(roundId);
  } catch (err: unknown) {
    const dequeueCount = Number(ctx.triggerMetadata?.["dequeueCount"] ?? 1);
    if (dequeueCount < MAX_DEQUEUE) throw err;
    getTelemetryClient()?.trackEvent({
      name: "signToFly.reflectFailed",
      properties: redactObject({ roundId, error: String(err) }) as Record<string, unknown>,
    });
  }
}

export async function handleSignToFlyReflectPoison(
  message: QueueMessage,
): Promise<void> {
  try {
    const { roundId } = parseReflectMessage(message);
    getTelemetryClient()?.trackEvent({
      name: "signToFly.reflectPoison",
      properties: redactObject({ roundId }) as Record<string, unknown>,
    });
  } catch (err: unknown) {
    getTelemetryClient()?.trackEvent({
      name: "signToFly.reflectPoison",
      properties: redactObject({ error: String(err) }) as Record<string, unknown>,
    });
  }
}

app.storageQueue("signToFlyReflect", {
  queueName: "signtofly-reflect",
  connection: "AzureWebJobsStorage",
  handler: handleSignToFlyReflectJob,
});

app.storageQueue("signToFlyReflectPoison", {
  queueName: "signtofly-reflect-poison",
  connection: "AzureWebJobsStorage",
  handler: handleSignToFlyReflectPoison,
});
