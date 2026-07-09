// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import * as z from "zod/v4";

import {
  healed,
  healingArray,
  jsonDeepEqual,
  lenientOptional,
  normalizeEnum,
} from "../helpers.js";

describe("healed", () => {
  test("keeps valid values unchanged", () => {
    const schema = healed(z.number(), 0);

    expect(schema.parse(12)).toBe(12);
  });

  test("returns fallback for invalid values", () => {
    const schema = healed(z.number(), 0);

    expect(schema.parse("12")).toBe(0);
  });

  test("does not throw for invalid values", () => {
    const schema = healed(z.object({ id: z.string() }), { id: "fallback" });

    expect(() => schema.parse({ id: 1 })).not.toThrow();
  });
});

describe("lenientOptional", () => {
  test("returns undefined for missing values", () => {
    const schema = lenientOptional(z.string());

    expect(schema.parse(undefined)).toBeUndefined();
  });

  test("keeps valid values", () => {
    const schema = lenientOptional(z.string());

    expect(schema.parse("abc")).toBe("abc");
  });

  test("returns undefined for invalid types", () => {
    const schema = lenientOptional(z.string());

    expect(schema.parse(123)).toBeUndefined();
  });

  test("does not throw for invalid types", () => {
    const schema = lenientOptional(z.array(z.string()));

    expect(() => schema.parse({ not: "array" })).not.toThrow();
  });
});

describe("healingArray", () => {
  test("keeps valid entries and drops invalid entries", () => {
    const schema = healingArray(z.string());

    expect(schema.parse(["a", 1, "b", null])).toEqual(["a", "b"]);
  });

  test("reduces length after dropping invalid object entries", () => {
    const schema = healingArray(z.object({ id: z.string() }));

    const result = schema.parse([{ id: "a" }, { id: 1 }, null, { id: "b" }]);

    expect(result).toHaveLength(2);
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("returns an empty array for non-array input", () => {
    const schema = healingArray(z.string());

    expect(schema.parse("not-array")).toEqual([]);
  });

  test("does not throw when element parsing rejects an entry", () => {
    const schema = healingArray(
      z.string().transform((value) => {
        if (value === "bad") {
          throw new Error("bad entry");
        }
        return value;
      }),
    );

    expect(() => schema.parse(["good", "bad", "still-good"])).not.toThrow();
    expect(schema.parse(["good", "bad", "still-good"])).toEqual([
      "good",
      "still-good",
    ]);
  });
});

describe("jsonDeepEqual", () => {
  test("treats object key order as insignificant", () => {
    expect(jsonDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  test("treats array order as positional", () => {
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
  });

  test("compares nested objects with reordered keys", () => {
    const left = { b: 2, a: 1, c: [{ y: 2, x: 1 }] };
    const right = { c: [{ x: 1, y: 2 }], a: 1, b: 2 };

    expect(jsonDeepEqual(left, right)).toBe(true);
  });

  test("compares primitive values", () => {
    expect(jsonDeepEqual("a", "a")).toBe(true);
    expect(jsonDeepEqual("a", "b")).toBe(false);
    expect(jsonDeepEqual(1, 1)).toBe(true);
    expect(jsonDeepEqual(true, false)).toBe(false);
  });

  test("distinguishes null from undefined", () => {
    expect(jsonDeepEqual(null, undefined)).toBe(false);
  });

  test("detects missing object keys", () => {
    expect(jsonDeepEqual({ a: undefined }, {})).toBe(false);
  });

  test("handles zod key reordering without false differences", () => {
    const original = { b: 2, a: 1, c: [{ y: 2, x: 1 }] };
    const parsed = z
      .object({
        a: z.number(),
        b: z.number(),
        c: z.array(z.object({ x: z.number(), y: z.number() })),
      })
      .parse(original);

    expect(jsonDeepEqual(original, parsed)).toBe(true);
  });
});

describe("normalizeEnum", () => {
  const values = ["Open", "Closed", "Draft"] as const;

  test("returns exact matches", () => {
    const normalize = normalizeEnum(values);

    expect(normalize("Open")).toBe("Open");
  });

  test("maps aliases", () => {
    const normalize = normalizeEnum(values, { open: "Open", oldClosed: "Closed" });

    expect(normalize("oldClosed")).toBe("Closed");
  });

  test("returns undefined for unknown values", () => {
    const normalize = normalizeEnum(values, { open: "Open" });

    expect(normalize("Missing")).toBeUndefined();
  });

  test("returns undefined for non-string raw values", () => {
    const normalize = normalizeEnum(values);

    expect(normalize(1)).toBeUndefined();
  });

  test("can be used with z.preprocess and healed", () => {
    const schema = healed(z.preprocess(normalizeEnum(values, { old: "Draft" }), z.enum(values)), "Open");

    expect(schema.parse("old")).toBe("Draft");
    expect(schema.parse("Missing")).toBe("Open");
  });
});
