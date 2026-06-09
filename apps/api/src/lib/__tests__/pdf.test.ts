import { describe, expect, it } from "vitest";
import type { RoundBrief } from "@bccweb/types";
import { renderBriefPdfHtml } from "../pdf.js";

function brief(overrides: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: "round-1",
    generatedAt: "2026-06-09T09:00:00.000Z",
    date: "2026-06-09",
    siteName: "Milk Hill",
    teams: [],
    ...overrides,
  };
}

describe("brief PDF safety fields", () => {
  it("includes safety labels", () => {
    const html = renderBriefPdfHtml(brief({
      NOTAMs: "Glider competition nearby",
      airspaceAndHazards: "Avoid CTA",
      expectedLandingArea: "North field",
      windSpeedDirection: "12kt SW",
      directionOfFlight: "East",
      BENO_LineDescription: "Do not cross ridge line",
      briefersNotes: "Watch sea breeze",
    }));

    expect(html).toContain("NOTAMs");
    expect(html).toContain("Airspace &amp; Hazards");
    expect(html).toContain("Expected Landing Area");
    expect(html).toContain("Wind Speed &amp; Direction");
    expect(html).toContain("Direction of Flight");
    expect(html).toContain("BENO Line Description");
    expect(html).toContain("Briefer's Notes");
  });

  it("renders missing fields as Not provided", () => {
    const html = renderBriefPdfHtml(brief());

    expect(html).toContain("Not provided");
  });

  it("renders briefer contact block when present", () => {
    const html = renderBriefPdfHtml(brief({
      briefer: {
        name: "Alex Briefer",
        bhpaCoachLevel: "Senior Coach",
        phoneNumber: "07123 456789",
        emailAddress: "alex@example.com",
      },
    }));

    expect(html).toContain("Alex Briefer");
    expect(html).toContain("Senior Coach");
    expect(html).toContain("07123 456789");
    expect(html).toContain("alex@example.com");
  });
});
