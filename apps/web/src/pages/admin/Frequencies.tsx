import { useEffect, useState } from "react";
import type { Frequency } from "@bccweb/types";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";
import { useAuth } from "../../hooks/useAuth.js";
import { api } from "../../lib/api.js";

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.55rem",
  border: "1px solid #cfd7df",
  borderRadius: "0.35rem",
  fontSize: "0.88rem",
};

const btnStyle = (color: string, bg: string): React.CSSProperties => ({
  padding: "0.4rem 0.75rem",
  background: bg,
  color,
  border: "none",
  borderRadius: "0.35rem",
  cursor: "pointer",
  fontWeight: 700,
  fontSize: "0.8rem",
});

export default function Frequencies() {
  const { identity, loading: authLoading } = useAuth();
  const [frequencies, setFrequencies] = useState<Frequency[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [position, setPosition] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const isAdmin = identity?.roles.includes("Admin");

  async function load() {
    setLoading(true);
    try {
      setFrequencies(await api.get<Frequency[]>("manage/frequencies"));
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to load frequencies");
      setOk(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authLoading && isAdmin) void load();
  }, [authLoading, isAdmin]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post<Frequency>("manage/frequencies", { label, position });
      setLabel("");
      setPosition(position + 1);
      setMsg("Frequency created.");
      setOk(true);
      await load();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to create frequency");
      setOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function update(frequency: Frequency) {
    const nextLabel = window.prompt("Frequency label", frequency.label);
    if (!nextLabel) return;
    const nextPosition = window.prompt("Position", String(frequency.position));
    if (!nextPosition) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.put<Frequency>(`manage/frequencies/${frequency.id}`, { label: nextLabel, position: Number.parseInt(nextPosition, 10) });
      setMsg("Frequency updated.");
      setOk(true);
      await load();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to update frequency");
      setOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove(frequency: Frequency) {
    if (!window.confirm(`Delete frequency "${frequency.label}"?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.delete<{ id: string }>(`manage/frequencies/${frequency.id}`);
      setMsg("Frequency deleted.");
      setOk(true);
      await load();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to delete frequency");
      setOk(false);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || loading) return <LoadingSpinner message="Loading frequencies…" />;
  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Frequencies</h1>
      {msg && <div style={{ padding: "0.55rem 0.7rem", borderRadius: "0.4rem", marginBottom: "1rem", background: ok ? "#d1e7dd" : "#f8d7da", color: ok ? "#0a3622" : "#58151c" }}>{msg}</div>}
      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.6rem", overflow: "hidden", marginBottom: "1rem" }}>
        {frequencies.map((frequency) => (
          <div key={frequency.id} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.7rem", borderTop: "1px solid #edf0f2" }}>
            <span style={{ width: 48, color: "#6c757d" }}>{frequency.position}</span>
            <strong style={{ flex: 1 }}>{frequency.label}</strong>
            <button disabled={busy} onClick={() => { void update(frequency); }} style={btnStyle("#333", "#e9ecef")}>Edit</button>
            <button disabled={busy} onClick={() => { void remove(frequency); }} style={btnStyle("#fff", "#dc3545")}>Delete</button>
          </div>
        ))}
        {frequencies.length === 0 && <p style={{ padding: "1rem", color: "#6c757d", margin: 0 }}>No frequencies configured.</p>}
      </div>
      <form onSubmit={(e) => { void create(e); }} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <strong>New</strong>
        <input required placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 180 }} />
        <input required type="number" value={position} onChange={(e) => setPosition(Number.parseInt(e.target.value, 10))} style={{ ...inputStyle, width: 96 }} />
        <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>{busy ? "Creating…" : "Create"}</button>
      </form>
    </div>
  );
}
