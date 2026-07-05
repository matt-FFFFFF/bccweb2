import { describe, expect, test } from "vitest";

import { ManufacturerSchema, ManufacturersIndexSchema } from "../manufacturer.js";

const validManufacturer = {
  id: "m1",
  legacyId: 42,
  name: "Ozone",
  websiteUrl: "https://ozone.com",
} as const;

describe("ManufacturerSchema", () => {
  test("round-trips a valid Manufacturer", () => {
    expect(ManufacturerSchema.parse(validManufacturer)).toEqual(validManufacturer);
  });

  test("strips unknown keys and preserves legacyId", () => {
    const result = ManufacturerSchema.safeParse({
      id: "m1",
      name: "Ozone",
      websiteUrl: "https://ozone.com",
      legacyId: 42,
      extra: 1,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extra");
      expect(result.data.legacyId).toBe(42);
    }
  });

  test("fails when id identity field is missing", () => {
    expect(ManufacturerSchema.safeParse({ name: "X" }).success).toBe(false);
  });

  test("heals an invalid optional websiteUrl to undefined", () => {
    const parsed = ManufacturerSchema.parse({ id: "m1", name: "Ozone", websiteUrl: 42 });

    expect(parsed.websiteUrl).toBeUndefined();
  });
});

describe("ManufacturersIndexSchema", () => {
  test("parses an array with a single manufacturer", () => {
    const result = ManufacturersIndexSchema.safeParse([{ id: "m1", name: "Ozone" }]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
    }
  });
});
