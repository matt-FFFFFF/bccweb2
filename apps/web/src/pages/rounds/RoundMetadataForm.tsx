// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import type { Round } from "@bccweb/types";
import { api } from "../../lib/api.js";
import { btnStyle, inputStyle } from "./RoundManage.shared.js";
import { Banner } from "../../components/Banner.js";

export function MetadataForm({
  round,
  onSaved,
}: {
  round: Round;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    maxTeams: String(round.maxTeams),
    minimumScore: String(round.minimumScore),

  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  function setF(k: keyof typeof form, v: string) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await api.put(`rounds/${round.id}`, {
        maxTeams: Number(form.maxTeams),
        minimumScore: Number(form.minimumScore),

      });
      setOk(true);
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const fi = { ...inputStyle, width: "100%" };

  return (
    <form onSubmit={(e) => { void submit(e); }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <div>
          <label htmlFor="round-max-teams" style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Max Teams</label>
          <input id="round-max-teams" type="number" min={1} style={fi} value={form.maxTeams} onChange={(e) => setF("maxTeams", e.target.value)} />
        </div>
        <div>
          <label htmlFor="round-minimum-score" style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Min Score</label>
          <input id="round-minimum-score" type="number" min={0} step={0.1} style={fi} value={form.minimumScore} onChange={(e) => setF("minimumScore", e.target.value)} />
        </div>

      </div>
      <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="submit"
          disabled={busy}
          style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {ok && <Banner msg="Saved." ok />}
        {err && <Banner msg={err} />}
      </div>
    </form>
  );
}
