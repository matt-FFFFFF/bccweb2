import assert from "node:assert/strict";
import test from "node:test";

import * as z from "zod/v4";

import { classifyRawToParsed, evaluateSchemaParse } from "../validate.mjs";

test("Given parsed object has fewer keys When classifier walks raw to parsed Then stripped key is reported", () => {
  const raw = { id: "pilot-1", person: { fullName: "Pilot One" }, email: "redacted@example.invalid" };
  const parsed = { id: "pilot-1", person: { fullName: "Pilot One" } };

  const result = classifyRawToParsed(raw, parsed);

  assert.deepEqual(result, { strips: ["email"], changes: [] });
});

test("Given parsed value differs When classifier walks raw to parsed Then changed key is reported", () => {
  const raw = { id: "site-1", name: "Site One", clubId: null };
  const parsed = { id: "site-1", name: "Site One", clubId: "" };

  const result = classifyRawToParsed(raw, parsed);

  assert.deepEqual(result, { strips: [], changes: ["clubId"] });
});

test("Given parsed injects defaults When classifier walks raw to parsed Then additive keys are ignored", () => {
  const raw = { id: "pilot-1", person: { fullName: "Pilot One" } };
  const parsed = { id: "pilot-1", person: { fullName: "Pilot One" }, seasonClubs: [], userId: null, legacyId: null };

  const result = classifyRawToParsed(raw, parsed);

  assert.deepEqual(result, { strips: [], changes: [] });
});

test("Given nested arrays are parsed When classifier walks raw to parsed Then nested strips and heals carry paths", () => {
  const raw = { slots: [{ pilot: { id: "p1", stale: true }, distance: "bad" }] };
  const parsed = { slots: [{ pilot: { id: "p1" }, distance: 0 }] };

  const result = classifyRawToParsed(raw, parsed);

  assert.deepEqual(result, { strips: ["slots[0].pilot.stale"], changes: ["slots[0].distance"] });
});

test("Given a schema reject candidate When classifier is called directly Then no values are emitted by the classifier", () => {
  const raw = { id: null };
  const parsed = { id: "" };

  const result = classifyRawToParsed(raw, parsed);

  assert.deepEqual(result, { strips: [], changes: ["id"] });
});

test("Given schema rejects raw data When parse gate evaluates it Then reject path is reported without values", () => {
  const schema = z.object({ id: z.string().min(1) }).strip();
  const raw = { id: null };

  const result = evaluateSchemaParse({ family: "sites", schema, raw });

  assert.deepEqual(result, { validated: false, rejects: ["id"], strips: [], heals: [] });
});

test("Given allowlisted site clubId heal When parse gate evaluates it Then heal is allowed", () => {
  const schema = z.object({ id: z.string().min(1), clubId: z.string().catch("") }).strip();
  const raw = { id: "site-1", clubId: null };

  const result = evaluateSchemaParse({ family: "sites", schema, raw, expectedHeals: new Set(["sites:clubId"]) });

  assert.deepEqual(result, { validated: true, rejects: [], strips: [], heals: [{ keyPath: "clubId", allowed: true }] });
});

test("Given unexpected scalar heal When parse gate evaluates it Then heal is not allowed", () => {
  const schema = z.object({ id: z.string().min(1), distance: z.number().catch(0) }).strip();
  const raw = { id: "round-1", distance: "bad" };

  const result = evaluateSchemaParse({ family: "rounds", schema, raw });

  assert.deepEqual(result, { validated: true, rejects: [], strips: [], heals: [{ keyPath: "distance", allowed: false }] });
});

test("Given a heal nested inside an array When parse gate normalizes the key Then the dot after the array index is kept", () => {
  const schema = z
    .object({ slots: z.array(z.object({ distance: z.number().catch(0) }).strip()) })
    .strip();
  const raw = { slots: [{ distance: "bad" }] };

  const result = evaluateSchemaParse({
    family: "rounds",
    schema,
    raw,
    expectedHeals: new Set(["rounds:slots.distance"]),
  });

  // Regression: the raw path slots[0].distance must normalize to slots.distance
  // (not slotsdistance), so the allowlist key rounds:slots.distance matches.
  assert.deepEqual(result, {
    validated: true,
    rejects: [],
    strips: [],
    heals: [{ keyPath: "slots.distance", allowed: true }],
  });
});
