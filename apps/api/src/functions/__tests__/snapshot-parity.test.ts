import { describe, expect, it } from "vitest";
import type { Pilot, PilotSnapshot, WingClass, PilotRatingValue } from "@bccweb/types";

// Mirrors the snapshot building logic in apps/api/src/functions/roundsMutate.ts
function buildLockRoundSnapshot(pilot: Pilot): PilotSnapshot {
  return {
    wingClass: (pilot.wingClass ?? "EN B") as WingClass,
    pilotRating: pilot.pilotRating,
    phoneNumber: pilot.person?.phoneNumber,
    helmetColour: pilot.helmetColour,
    harnessType: pilot.harnessType,
    harnessColour: pilot.harnessColour,
    wingManufacturer: pilot.wingManufacturer?.name,
    wingModel: pilot.wingModel,
    wingColours: pilot.wingColours,
    emergencyContactName: pilot.emergencyContactName,
    emergencyPhoneNumber: pilot.emergencyPhoneNumber,
    medicalInfo: pilot.medicalInfo,
  };
}

// Mirrors the snapshot building logic in scripts/migrate/migrate.mjs (after Task 24 fix)
function buildMigrateSnapshot(place: {
  WingClass?: string;
  PilotRatingDesc?: string;
  PhoneNumber?: string;
  HelmetColour?: string;
  HarnessType?: string;
  HarnessColour?: string;
  MfrName?: string | null;
  WingModel?: string;
  WingColours?: string;
  EmergencyContactName?: string;
  EmergencyPhoneNumber?: string;
  MedicalInfo?: string;
}): PilotSnapshot {
  return {
    wingClass: (place.WingClass ?? "EN B") as WingClass,
    pilotRating: (place.PilotRatingDesc ?? "Pilot") as PilotRatingValue,
    ...(place.PhoneNumber ? { phoneNumber: place.PhoneNumber } : {}),
    ...(place.HelmetColour ? { helmetColour: place.HelmetColour } : {}),
    ...(place.HarnessType ? { harnessType: place.HarnessType } : {}),
    ...(place.HarnessColour ? { harnessColour: place.HarnessColour } : {}),
    ...(place.MfrName ? { wingManufacturer: place.MfrName } : {}),
    ...(place.WingModel ? { wingModel: place.WingModel } : {}),
    ...(place.WingColours ? { wingColours: place.WingColours } : {}),
    ...(place.EmergencyContactName ? { emergencyContactName: place.EmergencyContactName } : {}),
    ...(place.EmergencyPhoneNumber ? { emergencyPhoneNumber: place.EmergencyPhoneNumber } : {}),
    ...(place.MedicalInfo ? { medicalInfo: place.MedicalInfo } : {}),
  };
}

describe("PilotSnapshot parity: lockRound vs migration", () => {
  it("identical pilot input produces identical snapshot from both code paths", () => {
    const pilot: Pilot = {
      id: "pilot-1",
      legacyId: null,
      coachType: "None",
      pilotRating: "Pilot",
      wingClass: "EN B",
      wingManufacturer: { id: "mfr-1", name: "Advance" },
      wingModel: "Alpha 7",
      wingColours: "Blue/White",
      helmetColour: "Red",
      harnessType: "Sup Air Delight",
      harnessColour: "Black",
      emergencyContactName: "Jane Doe",
      emergencyPhoneNumber: "+447700900000",
      medicalInfo: "Penicillin allergy",
      person: {
        id: "person-1",
        firstName: "John",
        lastName: "Pilot",
        fullName: "John Pilot",
        phoneNumber: "+447700900001",
      },
      currentClub: { id: "club-1", name: "BCC" },
      seasonClubs: [],
      userId: null,
    };

    const place = {
      WingClass: "EN B",
      PilotRatingDesc: "Pilot",
      PhoneNumber: "+447700900001",
      HelmetColour: "Red",
      HarnessType: "Sup Air Delight",
      HarnessColour: "Black",
      MfrName: "Advance",
      WingModel: "Alpha 7",
      WingColours: "Blue/White",
      EmergencyContactName: "Jane Doe",
      EmergencyPhoneNumber: "+447700900000",
      MedicalInfo: "Penicillin allergy",
    };

    const lockSnapshot = buildLockRoundSnapshot(pilot);
    const migrateSnapshot = buildMigrateSnapshot(place);

    expect(lockSnapshot).toEqual(migrateSnapshot);
  });

  it("wingManufacturer is the manufacturer name string (not UUID) in both code paths", () => {
    const pilot: Pilot = {
      id: "pilot-2",
      legacyId: null,
      coachType: "None",
      pilotRating: "Advanced Pilot",
      wingClass: "EN C",
      wingManufacturer: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", name: "Gin Gliders" },
      person: { id: "person-2", firstName: "A", lastName: "B", fullName: "A B" },
      seasonClubs: [],
      userId: null,
    };

    const place = {
      WingClass: "EN C",
      PilotRatingDesc: "Advanced Pilot",
      MfrName: "Gin Gliders",
    };

    const lockSnapshot = buildLockRoundSnapshot(pilot);
    const migrateSnapshot = buildMigrateSnapshot(place);

    expect(lockSnapshot.wingManufacturer).toBe("Gin Gliders");
    expect(migrateSnapshot.wingManufacturer).toBe("Gin Gliders");
    expect(lockSnapshot.wingManufacturer).toBe(migrateSnapshot.wingManufacturer);
  });

  it("pilot with no manufacturer produces undefined wingManufacturer in both paths", () => {
    const pilot: Pilot = {
      id: "pilot-3",
      legacyId: null,
      coachType: "None",
      pilotRating: "Pilot",
      wingClass: "EN A",
      person: { id: "person-3", firstName: "C", lastName: "D", fullName: "C D" },
      seasonClubs: [],
      userId: null,
    };

    const place = {
      WingClass: "EN A",
      PilotRatingDesc: "Pilot",
    };

    const lockSnapshot = buildLockRoundSnapshot(pilot);
    const migrateSnapshot = buildMigrateSnapshot(place);

    expect(lockSnapshot.wingManufacturer).toBeUndefined();
    expect(migrateSnapshot.wingManufacturer).toBeUndefined();
    expect(lockSnapshot).toEqual(migrateSnapshot);
  });
});
