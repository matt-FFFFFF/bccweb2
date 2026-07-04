import { useState, useRef, useEffect } from "react";
import type { Manufacturer } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api } from "../../lib/api.js";
import { useBlob } from "../../hooks/useBlob.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

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
  whiteSpace: "nowrap",
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

// ─── Inline Edit Row ─────────────────────────────────────────────────────────

function ManufacturerRow({
  manufacturer,
  onSaved,
  onDeleted,
}: {
  manufacturer: Manufacturer;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(manufacturer.name);
  const [websiteUrl, setWebsiteUrl] = useState(manufacturer.websiteUrl ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.put<Manufacturer>(`manufacturers/${manufacturer.id}`, { name, websiteUrl: websiteUrl || undefined });
      setMsg("Saved.");
      setMsgOk(true);
      setEditing(false);
      onSaved();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Deleting removes this from the picklist; pilots who already selected it keep their current value.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.delete(`manufacturers/${manufacturer.id}`);
      onDeleted();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "0.75rem 0", borderBottom: "1px solid #f5f5f5" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        {editing ? (
          <form onSubmit={(e) => { void save(e); }} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: 1, flexWrap: "wrap" }}>
            <input
              required
              placeholder="Name"
              style={{ ...inputStyle, minWidth: 160, flex: 1 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              placeholder="Website URL"
              style={{ ...inputStyle, minWidth: 160, flex: 1 }}
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
            />
            <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0d6efd")}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => { setEditing(false); setMsg(null); }} disabled={busy} style={btnStyle("#333", "#e9ecef")}>
              Cancel
            </button>
          </form>
        ) : (
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: 1 }}>
            <strong style={{ fontSize: "1rem" }}>{manufacturer.name}</strong>
            {manufacturer.websiteUrl && (
              <a href={manufacturer.websiteUrl} target="_blank" rel="noreferrer" style={{ fontSize: "0.85rem", color: "#0d6efd", textDecoration: "none" }}>
                {manufacturer.websiteUrl}
              </a>
            )}
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setEditing(true)} style={btnStyle("#333", "#e9ecef")}>
              Edit
            </button>
            <button type="button" onClick={() => { void remove(); }} style={btnStyle("#fff", "#dc3545")}>
              Delete
            </button>
          </div>
        )}
      </div>
      {msg && <div style={{ marginTop: "0.5rem" }}><Banner msg={msg} ok={msgOk} /></div>}
    </div>
  );
}

// ─── Create Form ─────────────────────────────────────────────────────────────

function CreateManufacturerForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post<Manufacturer>("manufacturers", { name, websiteUrl: websiteUrl || undefined });
      setName("");
      setWebsiteUrl("");
      setMsg("Manufacturer created.");
      setMsgOk(true);
      onCreated();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "1.25rem", paddingTop: "1rem", borderTop: "2px solid #dee2e6" }}
    >
      <strong style={{ fontSize: "0.85rem" }}>New Manufacturer</strong>
      <input
        required
        placeholder="Name"
        style={{ ...inputStyle, minWidth: 160, flex: 1 }}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        placeholder="Website URL (optional)"
        style={{ ...inputStyle, minWidth: 160, flex: 1 }}
        value={websiteUrl}
        onChange={(e) => setWebsiteUrl(e.target.value)}
      />
      <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>
        {busy ? "Creating…" : "Create"}
      </button>
      {msg && <Banner msg={msg} ok={msgOk} />}
    </form>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminManufacturers() {
  const { identity, loading: authLoading } = useAuth();
  const [refresh, setRefresh] = useState(0);

  const { data, loading, notFound } = useBlob<Manufacturer[]>(`manufacturers.json?v=${refresh}`);
  const manufacturersRef = useRef<Manufacturer[]>([]);

  if (data) manufacturersRef.current = data;
  else if (notFound) manufacturersRef.current = [];

  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => { if (data || notFound) setLoadedOnce(true); }, [data, notFound]);

  const isAdmin = identity?.roles.includes("Admin");

  if (authLoading || (!loadedOnce && loading)) {
    return <LoadingSpinner message="Loading manufacturers…" />;
  }

  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;

  const manufacturerList = data ?? manufacturersRef.current;
  const doRefresh = () => setRefresh((v) => v + 1);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Manufacturers</h1>

      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "0.75rem 1rem" }}>
        {manufacturerList.length === 0 && (
          <p style={{ color: "#888", fontSize: "0.85rem", margin: "0.25rem 0" }}>No manufacturers yet.</p>
        )}
        {manufacturerList.map((m) => (
          <ManufacturerRow
            key={m.id}
            manufacturer={m}
            onSaved={doRefresh}
            onDeleted={doRefresh}
          />
        ))}

        <CreateManufacturerForm onCreated={doRefresh} />
      </div>
    </div>
  );
}
