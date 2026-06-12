import { describe, expect, test } from "vitest";

import { PilotSchema, PilotSummarySchema } from "../pilot.js";

const validPilotSummary = {
  id: "pilot-1",
  legacyId: 1,
  name: "Ada Pilot",
  clubId: "club-1",
  rating: "Pilot",
} as const;

const validPilot = {
  id: "pilot-1",
  legacyId: 1,
  bhpaNumber: 123456,
  coachType: "ClubCoach",
  pilotRating: "Advanced Pilot",
  pureTrackId: 98765,
  pureTrackLink: "https://puretrack.io/pilot/98765",
  helmetColour: "White",
  harnessType: "Pod",
  harnessColour: "Black",
  emergencyContactName: "Emergency Contact",
  emergencyPhoneNumber: "07700 900001",
  medicalInfo: "Asthma inhaler in harness",
  wingClass: "EN C",
  wingManufacturer: {
    id: "manufacturer-1",
    name: "Ozone",
    websiteUrl: "https://example.test/ozone",
  },
  wingModel: "Delta",
  wingColours: "Blue and white",
  person: {
    id: "person-1",
    firstName: "Ada",
    lastName: "Pilot",
    fullName: "Ada Pilot",
    phoneNumber: "07700 900000",
  },
  currentClub: {
    id: "club-1",
    name: "Avon HGPG Club",
  },
  profileUpdatedAt: "2026-06-11T10:00:00.000Z",
  seasonClubs: [
    {
      seasonYear: 2026,
      clubId: "club-1",
      clubName: "Avon HGPG Club",
    },
  ],
  userId: "user-1",
  createdAt: "2026-06-11T09:00:00.000Z",
  updatedAt: "2026-06-11T10:00:00.000Z",
  updatedBy: "admin-1",
} as const;

describe("PilotSummarySchema", () => {
  test("round-trips a valid PilotSummary", () => {
    expect(PilotSummarySchema.parse(validPilotSummary)).toEqual(validPilotSummary);
  });

  test("strips extra PII fields from public PilotSummary", () => {
    const parsed = PilotSummarySchema.parse({
      ...validPilotSummary,
      bhpaNumber: 999,
      contact: "pilot@example.test",
    });

    expect(parsed).toEqual(validPilotSummary);
    expect(Object.keys(parsed).sort()).toEqual([
      "clubId",
      "id",
      "legacyId",
      "name",
      "rating",
    ]);
    expect(parsed).not.toHaveProperty("bhpaNumber");
    expect(parsed).not.toHaveProperty("contact");
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validPilotSummary;

    expect(PilotSummarySchema.safeParse(withoutId).success).toBe(false);
  });

  test("heals absent legacyId to null", () => {
    const { legacyId: _legacyId, ...withoutLegacyId } = validPilotSummary;

    expect(PilotSummarySchema.parse(withoutLegacyId)).toEqual({
      ...withoutLegacyId,
      legacyId: null,
    });
  });

  test("heals invalid rating to undefined and strips unknown keys", () => {
    const parsed = PilotSummarySchema.parse({
      ...validPilotSummary,
      rating: "Novice",
      junk: true,
    });

    expect(parsed).toEqual({ ...validPilotSummary, rating: undefined });
    expect(parsed).not.toHaveProperty("junk");
  });
});

describe("PilotSchema", () => {
  test("preserves PII fields on full private Pilot", () => {
    const parsed = PilotSchema.parse(validPilot);

    expect(parsed.bhpaNumber).toBe(validPilot.bhpaNumber);
    expect(parsed.pureTrackId).toBe(validPilot.pureTrackId);
    expect(parsed.wingManufacturer).toEqual(validPilot.wingManufacturer);
    expect(parsed.person.phoneNumber).toBe(validPilot.person.phoneNumber);
    expect(parsed.emergencyContactName).toBe(validPilot.emergencyContactName);
    expect(parsed.emergencyPhoneNumber).toBe(validPilot.emergencyPhoneNumber);
    expect(parsed.medicalInfo).toBe(validPilot.medicalInfo);
  });

  test("fails when id identity field is missing", () => {
    const { id: _id, ...withoutId } = validPilot;

    expect(PilotSchema.safeParse(withoutId).success).toBe(false);
  });

  test("does not optional-out person fullName display identity", () => {
    const { fullName: _fullName, ...personWithoutFullName } = validPilot.person;

    expect(
      PilotSchema.safeParse({ ...validPilot, person: personWithoutFullName }).success,
    ).toBe(false);
  });

  test("heals missing scalar defaults, legacyId, userId, and seasonClubs", () => {
    const minimal = {
      id: "pilot-2",
      person: {
        id: "person-2",
        firstName: "Grace",
        lastName: "Pilot",
        fullName: "Grace Pilot",
      },
    };

    expect(PilotSchema.parse(minimal)).toEqual({
      ...minimal,
      legacyId: null,
      coachType: "None",
      pilotRating: "Pilot",
      seasonClubs: [],
      userId: null,
    });
  });

  test("heals enum aliases and invalid optional scalar fields", () => {
    const parsed = PilotSchema.parse({
      ...validPilot,
      coachType: "senior_coach",
      pilotRating: "advanced_pilot",
      wingClass: "EN_C_2_LINER",
      pureTrackId: "not-a-number",
      wingManufacturer: {
        id: "manufacturer-2",
        name: "Gin",
        websiteUrl: 123,
      },
    });

    expect(parsed.coachType).toBe("SeniorCoach");
    expect(parsed.pilotRating).toBe("Advanced Pilot");
    expect(parsed.wingClass).toBe("EN C 2-liner");
    expect(parsed.pureTrackId).toBeUndefined();
    expect(parsed.wingManufacturer?.websiteUrl).toBeUndefined();
  });
});
