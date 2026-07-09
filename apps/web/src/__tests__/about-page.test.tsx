// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import About from "../pages/About.js";

describe("About page", () => {
  it("renders correctly with all required elements", () => {
    render(
      <MemoryRouter>
        <About />
      </MemoryRouter>
    );

    // heading with name matching /About the British Club Challenge/i is present
    expect(screen.getByRole("heading", { name: /About the British Club Challenge/i })).toBeInTheDocument();

    // an img with src `/images/AdvanceLogo.jpg`
    const img = screen.getByRole("img", { name: /ADVANCE/i });
    expect(img).toHaveAttribute("src", "/images/AdvanceLogo.jpg");

    // a Terms link with href `/terms`
    const termsLink = screen.getByRole("link", { name: /Terms and Conditions/i });
    expect(termsLink).toHaveAttribute("href", "/terms");

    // Facebook group anchor href `https://www.facebook.com/groups/370534829753625`
    const fbGroupLink = screen.getByRole("link", { name: /BCC Facebook Group/i });
    expect(fbGroupLink).toHaveAttribute("href", "https://www.facebook.com/groups/370534829753625");
    expect(fbGroupLink).toHaveAttribute("target", "_blank");
    expect(fbGroupLink).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // Facebook page anchor href `https://www.facebook.com/advancebcc`
    const fbPageLink = screen.getByRole("link", { name: /BCC Facebook Page/i });
    expect(fbPageLink).toHaveAttribute("href", "https://www.facebook.com/advancebcc");
    expect(fbPageLink).toHaveAttribute("target", "_blank");
    expect(fbPageLink).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // a mailto anchor href `mailto:coord@advance-bcc.uk`
    const mailtoLink = screen.getByRole("link", { name: /coord@advance-bcc.uk/i });
    expect(mailtoLink).toHaveAttribute("href", "mailto:coord@advance-bcc.uk");

    // the 4 PDF anchors exist with EXACT href
    const pdf1 = screen.getByRole("link", { name: /BCC Rules/i });
    expect(pdf1).toHaveAttribute("href", "/static/BCCRulesUpdateApril2025.pdf");
    expect(pdf1).toHaveAttribute("target", "_blank");
    expect(pdf1).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const pdf2 = screen.getByRole("link", { name: /BCC Briefing Aide Memoire/i });
    expect(pdf2).toHaveAttribute("href", "/static/AdvanceBCCBriefingAideMemoireApr2025.pdf");
    expect(pdf2).toHaveAttribute("target", "_blank");
    expect(pdf2).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const pdf3 = screen.getByRole("link", { name: /BCC COVID-19 Risk Assessment/i });
    expect(pdf3).toHaveAttribute("href", "/static/bcccovidra_04_2022.pdf");
    expect(pdf3).toHaveAttribute("target", "_blank");
    expect(pdf3).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const pdf4 = screen.getByRole("link", { name: /Paragliding Standard Operating Procedures \(SOPs\)/i });
    expect(pdf4).toHaveAttribute("href", "/static/ParaglidingSOPsv1.7.pdf");
    expect(pdf4).toHaveAttribute("target", "_blank");
    expect(pdf4).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
