/**
 * Round Brief PDF generator — Phase 4
 *
 * Uses Puppeteer Core + @sparticuz/chromium to render an inline HTML template
 * (compiled with Handlebars) to a PDF buffer.
 *
 * Environment variables:
 *   CHROMIUM_EXECUTABLE_PATH — override the chromium binary path for local dev
 *                              (not needed in Azure Functions — @sparticuz/chromium
 *                               provides the Linux binary automatically)
 */

import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import Handlebars from "handlebars";
import type { RoundBrief } from "@bccweb/types";

// ─── Handlebars helpers ───────────────────────────────────────────────────────

Handlebars.registerHelper("or", (a: unknown, b: unknown) => a || b);
Handlebars.registerHelper("formatDate", (iso: string) => {
  if (!iso) return "";
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
});
Handlebars.registerHelper("w3wLink", (w3w: string) => {
  if (!w3w) return "";
  const clean = w3w.replace(/^\/\/\//, "");
  return `https://what3words.com/${clean}`;
});

// ─── Template ─────────────────────────────────────────────────────────────────

const TEMPLATE_SRC = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BCC Round Brief — {{siteName}}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10pt;
    color: #1a1a1a;
    padding: 1.5cm 1.5cm 1.5cm 1.5cm;
  }
  h1 { font-size: 16pt; color: #1a4fa0; margin-bottom: 0.2rem; }
  h2 { font-size: 11pt; color: #1a4fa0; margin: 1rem 0 0.4rem; border-bottom: 1px solid #c0c8d8; padding-bottom: 0.2rem; }
  .header-meta { color: #444; margin-bottom: 1rem; font-size: 9pt; }
  .header-meta span { margin-right: 1.5rem; }
  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.4rem 1rem;
    margin-bottom: 0.75rem;
    font-size: 9pt;
  }
  .info-item label { font-weight: bold; color: #555; display: block; font-size: 8pt; }
  .info-item a { color: #1a4fa0; text-decoration: none; }
  .team-block { margin-bottom: 1.2rem; page-break-inside: avoid; }
  .team-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    background: #e8edf8;
    padding: 0.3rem 0.5rem;
    border-radius: 3px;
    margin-bottom: 0.3rem;
  }
  .team-name { font-weight: bold; font-size: 10pt; }
  .team-club { font-size: 8.5pt; color: #555; }
  .team-pt { font-size: 8pt; color: #777; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  th {
    background: #f0f2f8;
    text-align: left;
    padding: 0.25rem 0.4rem;
    border-bottom: 1px solid #c8cce0;
    font-size: 8pt;
    color: #444;
  }
  td { padding: 0.22rem 0.4rem; border-bottom: 1px solid #eef0f5; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .ns { color: #999; font-style: italic; }
  .med { color: #8b0000; font-weight: bold; }
  .footer {
    margin-top: 1.5rem;
    border-top: 1px solid #ddd;
    padding-top: 0.5rem;
    font-size: 7.5pt;
    color: #888;
    display: flex;
    justify-content: space-between;
  }
</style>
</head>
<body>

<h1>BCC Round Brief</h1>
<div class="header-meta">
  <span><strong>{{siteName}}</strong></span>
  <span>{{formatDate date}}</span>
  {{#if organisingClubName}}<span>Organised by: {{organisingClubName}}</span>{{/if}}
</div>

<h2>Site Information</h2>
<div class="info-grid">
  {{#if briefingTime}}
  <div class="info-item"><label>Briefing</label>{{briefingTime}}</div>
  {{/if}}
  {{#if checkInByTime}}
  <div class="info-item"><label>Check-in By</label>{{checkInByTime}}</div>
  {{/if}}
  {{#if landByTime}}
  <div class="info-item"><label>Land By</label>{{landByTime}}</div>
  {{/if}}
  {{#if parkingW3W}}
  <div class="info-item">
    <label>Parking (W3W)</label>
    <a href="{{w3wLink parkingW3W}}">{{parkingW3W}}</a>
  </div>
  {{/if}}
  {{#if briefingW3W}}
  <div class="info-item">
    <label>Briefing (W3W)</label>
    <a href="{{w3wLink briefingW3W}}">{{briefingW3W}}</a>
  </div>
  {{/if}}
  {{#if takeOffW3W}}
  <div class="info-item">
    <label>Take-off (W3W)</label>
    <a href="{{w3wLink takeOffW3W}}">{{takeOffW3W}}</a>
  </div>
  {{/if}}
  {{#if guideUrl}}
  <div class="info-item">
    <label>Site Guide</label>
    <a href="{{guideUrl}}">{{guideUrl}}</a>
  </div>
  {{/if}}
  {{#if pureTrackGroupName}}
  <div class="info-item">
    <label>PureTrack Group</label>
    <a href="https://puretrack.io/group/{{pureTrackGroupSlug}}">{{pureTrackGroupName}}</a>
  </div>
  {{/if}}
</div>

<h2>Teams &amp; Pilots</h2>

{{#each teams}}
<div class="team-block">
  <div class="team-header">
    <div>
      <span class="team-name">{{teamName}}</span>
      <span class="team-club"> &mdash; {{clubName}}</span>
    </div>
    {{#if pureTrackGroupSlug}}
    <span class="team-pt">PT: <a href="https://puretrack.io/group/{{pureTrackGroupSlug}}">{{pureTrackGroupSlug}}</a></span>
    {{/if}}
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Name</th>
        <th>BHPA</th>
        <th>Rating</th>
        <th>Wing Class</th>
        <th>Wing</th>
        <th>Colours</th>
        <th>Helmet</th>
        <th>Emergency</th>
        <th>Medical</th>
      </tr>
    </thead>
    <tbody>
    {{#each pilots}}
      <tr>
        <td>{{placeInTeam}}{{#unless isScoring}}<span class="ns">*</span>{{/unless}}</td>
        <td>{{name}}</td>
        <td>{{bhpaNumber}}</td>
        <td>{{snapshot.pilotRating}}</td>
        <td>{{snapshot.wingClass}}</td>
        <td>{{snapshot.wingManufacturer}} {{snapshot.wingModel}}</td>
        <td>{{snapshot.wingColours}}</td>
        <td>{{snapshot.helmetColour}}</td>
        <td>
          {{#if snapshot.emergencyContactName}}
            {{snapshot.emergencyContactName}}
            {{#if snapshot.emergencyPhoneNumber}}&nbsp;{{snapshot.emergencyPhoneNumber}}{{/if}}
          {{/if}}
        </td>
        <td>{{#if snapshot.medicalInfo}}<span class="med">{{snapshot.medicalInfo}}</span>{{/if}}</td>
      </tr>
    {{/each}}
    </tbody>
  </table>
</div>
{{/each}}

<div class="footer">
  <span>BCC Competition Management System</span>
  <span>Generated: {{generatedAt}}</span>
</div>

</body>
</html>`;

const compiledTemplate = Handlebars.compile(TEMPLATE_SRC);

// ─── PDF generation ───────────────────────────────────────────────────────────

/**
 * Generate a PDF buffer from a RoundBrief.
 * Uses @sparticuz/chromium in production (Azure Functions Linux) and
 * CHROMIUM_EXECUTABLE_PATH for local macOS development.
 */
export async function generateBriefPdf(brief: RoundBrief): Promise<Buffer> {
  const html = compiledTemplate({
    ...brief,
    generatedAt: new Date(brief.generatedAt).toLocaleString("en-GB", {
      timeZone: "Europe/London",
    }),
  });

  // Resolve executable path
  const executablePath =
    process.env["CHROMIUM_EXECUTABLE_PATH"] ??
    (await chromium.executablePath());

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 800 },
    executablePath,
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    // Puppeteer returns Uint8Array; convert to Buffer for downstream use
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
