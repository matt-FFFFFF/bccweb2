import { describe, expect, test } from "vitest";

import { SiteSchema, SiteStatusSchema, SiteSummarySchema } from "../site.js";

const validSiteSummary = {
  id: "site-1",
  name: "Llangollen",
  status: "Active",
  clubId: "club-1",
} as const;

const validSite = {
  ...validSiteSummary,
  legacyId: 123,
  parkingW3W: "filled.count.soap",
  briefingW3W: "scale.paper.trace",
  takeOffW3W: "rental.shape.tests",
  guideUrl: "https://example.test/sites/llangollen",
  contactInfo: "Call the site officer before flying.",
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T01:00:00.000Z",
  updatedBy: "user-1",
  lat: 52.9708,
  lng: -3.1719,
} as const;

describe("SiteStatusSchema", () => {
  test("accepts canonical site status values", () => {
    expect(SiteStatusSchema.parse("Inactive")).toBe("Inactive");
  });

  test("maps legacy status aliases to canonical values", () => {
    expect(SiteStatusSchema.parse("disabled")).toBe("Inactive");
  });
});

describe("SiteSummarySchema", () => {
  test("round-trips a valid SiteSummary", () => {
    expect(SiteSummarySchema.parse(validSiteSummary)).toEqual(validSiteSummary);
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validSiteSummary;

    expect(SiteSummarySchema.safeParse(withoutId).success).toBe(false);
  });

  test("fails when name identity field is missing", () => {
    const { name: _name, ...withoutName } = validSiteSummary;

    expect(SiteSummarySchema.safeParse(withoutName).success).toBe(false);
  });
});

describe("SiteSchema", () => {
  test("round-trips a valid Site", () => {
    expect(SiteSchema.parse(validSite)).toEqual(validSite);
  });

  test("heals out-of-range coordinates to null instead of throwing", () => {
    const parsed = SiteSchema.parse({ ...validSiteSummary, lat: 999, lng: -999 });

    expect(parsed.lat).toBeNull();
    expect(parsed.lng).toBeNull();
  });

  test("preserves valid coordinate boundaries", () => {
    const parsed = SiteSchema.parse({ ...validSiteSummary, lat: -90, lng: 180 });

    expect(parsed.lat).toBe(-90);
    expect(parsed.lng).toBe(180);
  });

  test("defaults missing optional coordinates to null", () => {
    const parsed = SiteSchema.parse(validSiteSummary);

    expect(parsed.lat).toBeNull();
    expect(parsed.lng).toBeNull();
  });

  test("strips unknown Site keys", () => {
    const parsed = SiteSchema.parse({ ...validSite, obsolete: true });

    expect(parsed).not.toHaveProperty("obsolete");
  });
});
