// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, test, vi } from "vitest";

const { hashMock } = vi.hoisted(() => ({
  hashMock: vi.fn(async (_password: string, cost: number) => `hash:${cost}`),
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: hashMock,
    compare: vi.fn(),
  },
}));

async function loadAuthHelpers() {
  vi.resetModules();
  return import("../authHelpers.js");
}

beforeEach(() => {
  hashMock.mockClear();
  delete process.env.NODE_ENV;
  delete process.env.TEST_BCRYPT_COST;
});

describe("BCRYPT_COST gate", () => {
  test("production ignores TEST_BCRYPT_COST and uses 12", async () => {
    process.env.NODE_ENV = "production";
    process.env.TEST_BCRYPT_COST = "4";

    const { hashPassword } = await loadAuthHelpers();
    await expect(hashPassword("pw")).resolves.toBe("hash:12");
  });

  test("test honors TEST_BCRYPT_COST=4", async () => {
    process.env.NODE_ENV = "test";
    process.env.TEST_BCRYPT_COST = "4";

    const { hashPassword } = await loadAuthHelpers();
    await expect(hashPassword("pw")).resolves.toBe("hash:4");
  });

  test("test falls back to 12 for garbage TEST_BCRYPT_COST", async () => {
    process.env.NODE_ENV = "test";
    process.env.TEST_BCRYPT_COST = "garbage";

    const { hashPassword } = await loadAuthHelpers();
    await expect(hashPassword("pw")).resolves.toBe("hash:12");
  });
});
