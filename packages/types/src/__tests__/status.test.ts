import { describe, expect, it } from "vitest";
import { normalizeStatus, isRosterFrozen } from "../status.js";

describe("normalizeStatus", () => {
  it.each([
    ["submitted", "Proposed"],
    ["verified", "Confirmed"],
    ["brief complete", "BriefComplete"],
    ["briefcomplete", "BriefComplete"],
    ["deleted", "Cancelled"],
  ])("maps legacy status %s -> %s", (raw, expected) => {
    expect(normalizeStatus(raw)).toBe(expected);
  });

  it.each([
    "Proposed",
    "Confirmed",
    "BriefComplete",
    "Locked",
    "Complete",
    "Cancelled",
  ])("passes through canonical status %s", (raw) => {
    expect(normalizeStatus(raw)).toBe(raw);
  });

  it("throws on unknown status", () => {
    expect(() => normalizeStatus("  weird status  ")).toThrow(
      "Unknown status:   weird status  "
    );
  });
});

describe("isRosterFrozen", () => {
  it.each(["Proposed", "Confirmed"] as const)(
    "roster editable at %s",
    (status) => {
      expect(isRosterFrozen(status)).toBe(false);
    },
  );

  it.each(["BriefComplete", "Locked", "Complete", "Cancelled"] as const)(
    "roster frozen at %s",
    (status) => {
      expect(isRosterFrozen(status)).toBe(true);
    },
  );
});
