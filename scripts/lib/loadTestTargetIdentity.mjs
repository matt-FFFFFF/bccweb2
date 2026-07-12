// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";

const LOCAL_BLOB_IDENTITY = {
  accountName: "devstoreaccount1",
  blobEndpoint: "http://127.0.0.1:10000/devstoreaccount1",
};

function connectionIdentity(connectionString, fallback = null) {
  if (!connectionString) return fallback;
  const values = Object.fromEntries(
    connectionString
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [part.slice(0, separator).toLowerCase(), part.slice(separator + 1)];
      }),
  );
  return {
    accountName: values.accountname ?? null,
    blobEndpoint: values.blobendpoint ?? null,
    queueEndpoint: values.queueendpoint ?? null,
    endpointSuffix: values.endpointsuffix ?? null,
  };
}

export function loadTestTargetIdentity(baseUrl, environment = process.env) {
  const target = {
    apiOrigin: new URL(baseUrl).origin.toLowerCase(),
    blob: connectionIdentity(environment.BLOB_CONNECTION_STRING, LOCAL_BLOB_IDENTITY),
    queues: connectionIdentity(environment.AzureWebJobsStorage),
  };
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}
