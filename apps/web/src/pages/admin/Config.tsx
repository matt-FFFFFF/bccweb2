import { useEffect, useState } from "react";
import type { Config, WingClass } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api } from "../../lib/api.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

const WING_CLASSES: WingClass[] = ["EN A", "EN B", "EN C", "EN C 2-liner", "EN D", "EN D 2-liner"];

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const btnStyle = (color: string, bg: string): React.CSSProperties => ({
  padding: "0.35rem 0.75rem",
  background: bg,
  color,
  border: "none",
  borderRadius: "0.3rem",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.8rem",
});

function Banner({ msg, ok }: { msg: string; ok?: boolean }) {
  return (
    <div style={{
      padding: "0.4rem 0.6rem",
      borderRadius: "0.3rem",
      fontSize: "0.8rem",
      background: ok ? "#d1e7dd" : "#f8d7da",
      color: ok ? "#0a3622" : "#58151c",
    }}>
      {msg}
    </div>
  );
}

interface FormState {
  maxTeamsInClub: string;
  maxPilotsInTeam: string;
  maxScoringPilotsInTeam: string;
  flightDateValidationEnabled: boolean;
  wingFactors: Record<WingClass, string>;
}

const DEFAULT_WING_FACTORS: Record<WingClass, number> = {
  "EN A": 1.0,
  "EN B": 0.9,
  "EN C": 0.8,
  "EN C 2-liner": 0.7,
  "EN D": 0.6,
  "EN D 2-liner": 0.5,
};

function configToForm(c: Partial<Config> | null | undefined): FormState {
  const safe = c ?? {};
  const wf = (safe.wingFactors ?? {}) as Partial<Record<WingClass, number>>;
  return {
    maxTeamsInClub: String(safe.maxTeamsInClub ?? 2),
    maxPilotsInTeam: String(safe.maxPilotsInTeam ?? 12),
    maxScoringPilotsInTeam: String(safe.maxScoringPilotsInTeam ?? 6),
    flightDateValidationEnabled: safe.flightDateValidationEnabled ?? true,
    wingFactors: Object.fromEntries(
      WING_CLASSES.map((wc) => [wc, String(wf[wc] ?? DEFAULT_WING_FACTORS[wc])])
    ) as Record<WingClass, string>,
  };
}

export default function AdminConfig() {
  const { identity, loading: authLoading } = useAuth();
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const isAdmin = identity?.roles.includes("Admin");

  useEffect(() => {
    if (!isAdmin) return;
    async function load() {
      try {
        const cfg = await api.get<Config>("manage/config");
        setForm(configToForm(cfg));
      } catch (ex) {
        setLoadErr(ex instanceof Error ? ex.message : "Failed to load config");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [isAdmin]);

  function setF<K extends keyof Omit<FormState, "wingFactors">>(k: K, v: FormState[K]) {
    setForm((p) => p ? { ...p, [k]: v } : p);
  }

  function setWingFactor(wc: WingClass, v: string) {
    setForm((p) => p ? { ...p, wingFactors: { ...p.wingFactors, [wc]: v } } : p);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      const body: Config = {
        maxTeamsInClub: Number(form.maxTeamsInClub),
        maxPilotsInTeam: Number(form.maxPilotsInTeam),
        maxScoringPilotsInTeam: Number(form.maxScoringPilotsInTeam),
        flightDateValidationEnabled: form.flightDateValidationEnabled,
        wingFactors: Object.fromEntries(
          WING_CLASSES.map((wc) => [wc, Number(form.wingFactors[wc])])
        ) as Record<WingClass, number>,
      };
      await api.put("manage/config", body);
      setMsg("Config saved.");
      setMsgOk(true);
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to save");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || loading) return <LoadingSpinner message="Loading config…" />;
  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;
  if (loadErr) return <div style={{ padding: "0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem" }}>{loadErr}</div>;
  if (!form) return null;

  const fi = { ...inputStyle, width: "100%" };

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>League Config</h1>

      <form onSubmit={(e) => { void handleSubmit(e); }}>
        <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "1rem", marginBottom: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Team / Pilot limits</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.75rem" }}>
            <div>
              <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Max teams per club</label>
              <input type="number" min={1} style={fi} value={form.maxTeamsInClub} onChange={(e) => setF("maxTeamsInClub", e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Max pilots per team</label>
              <input type="number" min={1} style={fi} value={form.maxPilotsInTeam} onChange={(e) => setF("maxPilotsInTeam", e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>Max scoring pilots</label>
              <input type="number" min={1} style={fi} value={form.maxScoringPilotsInTeam} onChange={(e) => setF("maxScoringPilotsInTeam", e.target.value)} />
            </div>
          </div>
          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginTop: "0.75rem", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={form.flightDateValidationEnabled}
              onChange={(e) => setF("flightDateValidationEnabled", e.target.checked)}
            />
            Flight date validation enabled
          </label>
        </div>

        <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "1rem", marginBottom: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Wing factors</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "0.75rem" }}>
            {WING_CLASSES.map((wc) => (
              <div key={wc}>
                <label style={{ fontSize: "0.8rem", color: "#555", display: "block" }}>{wc}</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  style={fi}
                  value={form.wingFactors[wc]}
                  onChange={(e) => setWingFactor(wc, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}>
            {busy ? "Saving…" : "Save config"}
          </button>
          {msg && <Banner msg={msg} ok={msgOk} />}
        </div>
      </form>
    </div>
  );
}
