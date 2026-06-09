import { describe, expect, it } from "vitest";
import { normalizeStatus } from "../status.js";

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
