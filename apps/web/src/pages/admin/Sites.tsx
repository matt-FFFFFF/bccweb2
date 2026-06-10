import { useEffect, useState } from "react";
import type { Site, SiteSummary, ClubSummary, SiteStatus } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
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

function emptyForm(defaultClubId: string): SiteFormState {
  return {
    name: "",
    status: "Active",
    clubId: defaultClubId,
    parkingW3W: "",
    briefingW3W: "",
    takeOffW3W: "",
    guideUrl: "",
    contactInfo: "",
  };
}

function clubNameFor(clubs: ClubSummary[], clubId: string): string {
  return clubs.find((c) => c.id === clubId)?.name ?? clubId;
}

function SiteEditRow({
  site,
  clubs,
  isAdmin,
  onSaved,
  onDeleted,
}: {
  site: SiteSummary;
  clubs: ClubSummary[];
  isAdmin: boolean;
  onSaved: () => void;
  onDeleted: () => void;
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
  const [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // SiteSummary lacks W3W/guideUrl/contactInfo — fetch full private blob on first open.
  useEffect(() => {
    if (!open || hydrated) return;
    let cancelled = false;
    api
      .get<Site>(`sites/${site.id}`)
      .then((full) => {
        if (cancelled) return;
        setForm({
          name: full.name,
          status: full.status,
          clubId: full.clubId,
          parkingW3W: full.parkingW3W ?? "",
          briefingW3W: full.briefingW3W ?? "",
          takeOffW3W: full.takeOffW3W ?? "",
          guideUrl: full.guideUrl ?? "",
          contactInfo: full.contactInfo ?? "",
        });
        setHydrated(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "Failed to load site");
      });
    return () => {
      cancelled = true;
    };
  }, [open, hydrated, site.id]);

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
        clubId: isAdmin ? form.clubId : undefined,
        parkingW3W: form.parkingW3W || undefined,
        briefingW3W: form.briefingW3W || undefined,
        takeOffW3W: form.takeOffW3W || undefined,
        guideUrl: form.guideUrl || undefined,
        contactInfo: form.contactInfo || undefined,
      });
      setMsg("Saved.");
      setMsgOk(true);
      setHydrated(false);
      onSaved();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : "Failed");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete site "${site.name}"? This cannot be undone.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.delete<void>(`sites/${site.id}`);
      onDeleted();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : "Delete failed");
      setMsgOk(false);
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
          {loadError && (
            <div style={{ gridColumn: "1 / -1" }}>
              <Banner msg={loadError} />
            </div>
          )}
          {!hydrated && !loadError && (
            <div style={{ gridColumn: "1 / -1", fontSize: "0.8rem", color: "#888" }}>
              Loading site details…
            </div>
          )}
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
            <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>
              Club{!isAdmin && " (locked)"}
            </label>
            {isAdmin ? (
              <select style={fi} value={form.clubId} onChange={(e) => setF("clubId", e.target.value)}>
                {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <input style={{ ...fi, background: "#f1f3f5" }} value={clubNameFor(clubs, form.clubId)} disabled readOnly />
            )}
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
            <button type="button" disabled={busy} onClick={() => { void handleDelete(); }} style={btnStyle("#fff", busy ? "#6c757d" : "#b02a37")}>
              Delete
            </button>
            {msg && <Banner msg={msg} ok={msgOk} />}
          </div>
        </form>
      )}
    </div>
  );
}

function CreateSiteForm({
  clubs,
  isAdmin,
  defaultClubId,
  onCreated,
}: {
  clubs: ClubSummary[];
  isAdmin: boolean;
  defaultClubId: string;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<SiteFormState>(() => emptyForm(defaultClubId));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  function setF<K extends keyof SiteFormState>(k: K, v: SiteFormState[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clubId) {
      setMsg("Pick a club.");
      setMsgOk(false);
      return;
    }
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
      setForm(emptyForm(defaultClubId));
      setMsg("Site created.");
      setMsgOk(true);
      onCreated();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : "Failed");
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
          <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>
            Club *{!isAdmin && " (your club)"}
          </label>
          {isAdmin ? (
            <select required style={fi} value={form.clubId} onChange={(e) => setF("clubId", e.target.value)}>
              <option value="">— select —</option>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <input style={{ ...fi, background: "#f1f3f5" }} value={clubNameFor(clubs, form.clubId)} disabled readOnly />
          )}
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

  const isAdmin = identity?.roles.includes("Admin") ?? false;
  const isCoord = identity?.roles.includes("RoundsCoord") ?? false;

  if (authLoading || sitesLoading || clubsLoading) return <LoadingSpinner message="Loading sites…" />;
  if (!isAdmin && !isCoord) {
    return <p style={{ color: "#721c24" }}>Admin or RoundsCoord access required.</p>;
  }
  if (!isAdmin && !identity?.clubId) {
    return <p style={{ color: "#721c24" }}>Your coord account is not linked to a club. Contact an admin.</p>;
  }

  const visibleSites = isAdmin
    ? (sites ?? [])
    : (sites ?? []).filter((s) => s.clubId === identity?.clubId);
  const sortedSites = visibleSites.slice().sort((a, b) => a.name.localeCompare(b.name));

  const defaultClubId = isAdmin ? "" : (identity?.clubId ?? "");

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>
        Sites{!isAdmin && clubs && identity?.clubId && ` — ${clubNameFor(clubs, identity.clubId)}`}
      </h1>

      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "0.75rem 1rem" }}>
        {sortedSites.length === 0 && (
          <p style={{ color: "#888", fontSize: "0.85rem", margin: "0.25rem 0" }}>
            No sites yet.
          </p>
        )}
        {sortedSites.map((s) => (
          <SiteEditRow
            key={s.id}
            site={s}
            clubs={clubs ?? []}
            isAdmin={isAdmin}
            onSaved={() => setRefresh((v) => v + 1)}
            onDeleted={() => setRefresh((v) => v + 1)}
          />
        ))}
        <CreateSiteForm
          clubs={clubs ?? []}
          isAdmin={isAdmin}
          defaultClubId={defaultClubId}
          onCreated={() => setRefresh((v) => v + 1)}
        />
      </div>
    </div>
  );
}
