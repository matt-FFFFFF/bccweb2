// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { Blob } from "node:buffer";
import type { HttpRequest, HttpRequestUser } from "@azure/functions";
import { MockHttpRequest } from "../../__tests__/helpers/api.js";
import { signAccessToken } from "../../lib/authHelpers.js";
import type {
  HarnessRequest,
  TestUser,
} from "./issue8EvidenceHarness.js";

export class EvidenceHttpRequest extends MockHttpRequest implements HttpRequest {
  readonly user: HttpRequestUser | null = null;
  readonly body = null;
  readonly bodyUsed = false;
  readonly #serializedBody: string;
  readonly #user: TestUser;
  readonly #request: HarnessRequest;

  constructor(user: TestUser, request: HarnessRequest) {
    const body = request.body ?? {};
    super({
      method: request.method,
      headers: {
        authorization: `Bearer ${signAccessToken(user.id, user.email, 0)}`,
        "content-type": "application/json",
        "x-forwarded-for": randomIp(),
      },
      params: request.params ?? {},
      query: request.query ?? {},
      body,
    });
    this.#serializedBody = JSON.stringify(body);
    this.#user = user;
    this.#request = request;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Blob([this.#serializedBody]).arrayBuffer();
  }

  async blob(): Promise<Blob> {
    return new Blob([this.#serializedBody], { type: "application/json" });
  }

  async formData(): Promise<FormData> {
    return new Response(this.#serializedBody, {
      headers: { "content-type": "application/json" },
    }).formData();
  }

  clone(): HttpRequest {
    return new EvidenceHttpRequest(this.#user, this.#request);
  }
}

function randomIp(): string {
  return `10.88.${Math.floor(Math.random() * 250) + 1}.${Math.floor(
    Math.random() * 250
  ) + 1}`;
}
