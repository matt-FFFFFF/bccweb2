import { useState } from "react";
import type { Site, SiteSummary, ClubSummary, SiteStatus } from "@bccweb/types";
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

interface SiteFormState {
  name: string;
  status: SiteStatus;
  clubId: string;
  parkingW3W: string;
  briefingW3W: string;
  takeOffW3W: string;
  guideUrl: string;
  contactInfo: string;
}

function emptyForm(clubs: ClubSummary[]): SiteFormState {
  return {
    name: "",
    status: "Active",
    clubId: clubs[0]?.id ?? "",
    parkingW3W: "",
    briefingW3W: "",
    takeOffW3W: "",
    guideUrl: "",
    contactInfo: "",
  };
}

function SiteEditRow({
  site,
  clubs,
  onSaved,
}: {
  site: SiteSummary;
  clubs: ClubSummary[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SiteFormState>({
    name: site.name,
    status: site.status,
    clubId: site.clubId,
    parkingW3W: "",
    briefingW3W: "",
    takeOffW3W: "",
    guideUrl: "",
    contactInfo: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  function setF<K extends keyof SiteFormState>(k: K, v: SiteFormState[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.put<Site>(`sites/${site.id}`, {
        name: form.name,
        status: form.status,
        clubId: form.clubId,
        parkingW3W: form.parkingW3W || undefined,
        briefingW3W: form.briefingW3W || undefined,
        takeOffW3W: form.takeOffW3W || undefined,
        guideUrl: form.guideUrl || undefined,
        contactInfo: form.contactInfo || undefined,
      });
      setMsg("Saved.");
      setMsgOk(true);
      onSaved();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  const fi = { ...inputStyle, width: "100%" };

  return (
    <div style={{ borderBottom: "1px solid #f0f0f0", padding: "0.5rem 0" }}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <span style={{ flex: 1, fontSize: "0.9rem" }}>
          <strong>{site.name}</strong>
          <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: site.status === "Active" ? "#0a3622" : "#888" }}>
            {site.status}
          </span>
        </span>
        <button
          style={btnStyle("#333", "#e9ecef")}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open && (
        <form
          onSubmit={(e) => { void save(e); }}
          style={{ marginTop: "0.75rem", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.5rem" }}
        >
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Name *</label>
            <input required style={fi} value={form.name} onChange={(e) => setF("name", e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Status</label>
            <select style={fi} value={form.status} onChange={(e) => setF("status", e.target.value as SiteStatus)}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Club</label>
            <select style={fi} value={form.clubId} onChange={(e) => setF("clubId", e.target.value)}>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Parking W3W</label>
            <input style={fi} value={form.parkingW3W} onChange={(e) => setF("parkingW3W", e.target.value)} placeholder="///word.word.word" />
          </div>
          <div>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Briefing W3W</label>
            <input style={fi} value={form.briefingW3W} onChange={(e) => setF("briefingW3W", e.target.value)} placeholder="///word.word.word" />
          </div>
          <div>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Take-off W3W</label>
            <input style={fi} value={form.takeOffW3W} onChange={(e) => setF("takeOffW3W", e.target.value)} placeholder="///word.word.word" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Guide URL</label>
            <input type="url" style={fi} value={form.guideUrl} onChange={(e) => setF("guideUrl", e.target.value)} placeholder="https://…" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Contact info</label>
            <input style={fi} value={form.contactInfo} onChange={(e) => setF("contactInfo", e.target.value)} />
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}>
              {busy ? "Saving…" : "Save"}
            </button>
            {msg && <Banner msg={msg} ok={msgOk} />}
          </div>
        </form>
      )}
    </div>
  );
}

function CreateSiteForm({ clubs, onCreated }: { clubs: ClubSummary[]; onCreated: () => void }) {
  const [form, setForm] = useState<SiteFormState>(() => emptyForm(clubs));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  function setF<K extends keyof SiteFormState>(k: K, v: SiteFormState[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post<Site>("sites", {
        name: form.name,
        status: form.status,
        clubId: form.clubId,
        parkingW3W: form.parkingW3W || undefined,
        briefingW3W: form.briefingW3W || undefined,
        takeOffW3W: form.takeOffW3W || undefined,
        guideUrl: form.guideUrl || undefined,
        contactInfo: form.contactInfo || undefined,
      });
      setForm(emptyForm(clubs));
      setMsg("Site created.");
      setMsgOk(true);
      onCreated();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  const fi = { ...inputStyle, width: "100%" };

  return (
    <form
      onSubmit={(e) => { void submit(e); }}
      style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "2px solid #dee2e6" }}
    >
      <strong style={{ fontSize: "0.85rem" }}>New Site</strong>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.5rem", marginTop: "0.5rem" }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Name *</label>
          <input required style={fi} value={form.name} onChange={(e) => setF("name", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Club *</label>
          <select required style={fi} value={form.clubId} onChange={(e) => setF("clubId", e.target.value)}>
            <option value="">— select —</option>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Status</label>
          <select style={fi} value={form.status} onChange={(e) => setF("status", e.target.value as SiteStatus)}>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        </div>
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>
            {busy ? "Creating…" : "Create Site"}
          </button>
          {msg && <Banner msg={msg} ok={msgOk} />}
        </div>
      </div>
    </form>
  );
}

export default function AdminSites() {
  const { identity, loading: authLoading } = useAuth();
  const [refresh, setRefresh] = useState(0);
  const { data: sites, loading: sitesLoading } = useBlob<SiteSummary[]>(`sites.json?v=${refresh}`);
  const { data: clubs, loading: clubsLoading } = useBlob<ClubSummary[]>("clubs.json");

  const isAdmin = identity?.roles.includes("Admin");

  if (authLoading || sitesLoading || clubsLoading) return <LoadingSpinner message="Loading sites…" />;
  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;

  const sortedSites = (sites ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Sites</h1>

      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "0.75rem 1rem" }}>
        {sortedSites.map((s) => (
          <SiteEditRow key={s.id} site={s} clubs={clubs ?? []} onSaved={() => setRefresh((v) => v + 1)} />
        ))}
        <CreateSiteForm clubs={clubs ?? []} onCreated={() => setRefresh((v) => v + 1)} />
      </div>
    </div>
  );
}
