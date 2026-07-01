import { useEffect, useState } from "react";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";
import { MarkdownEditor } from "../../components/MarkdownEditor.js";
import { MarkdownView } from "../../components/MarkdownView.js";

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

interface WordingVersion {
  version: number;
  blobPath: string;
  lastModified: string;
}

interface ActiveWording {
  version: number;
  markdown: string;
}

export default function AdminSignToFlyWording() {
  const { identity, loading: authLoading } = useAuth();
  const [active, setActive] = useState<ActiveWording | null>(null);
  const [history, setHistory] = useState<WordingVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [formMarkdown, setFormMarkdown] = useState("");

  const isAdmin = identity?.roles.includes("Admin");

  async function load() {
    setLoading(true);
    setLoadErr(null);
    try {
      const [activeResult, historyResult] = await Promise.allSettled([
        api.get<ActiveWording>("sign-to-fly/wording/active"),
        api.get<WordingVersion[]>("manage/sign-to-fly/wording")
      ]);

      if (activeResult.status === "fulfilled") {
        const act = activeResult.value;
        setActive(act);
        if (!formMarkdown && act) {
          setFormMarkdown(act.markdown);
        }
      } else if (activeResult.reason instanceof ApiError && activeResult.reason.code === "WORDING_NOT_SEEDED") {
        setActive(null);
      } else {
        const err = activeResult.reason;
        setLoadErr(err instanceof Error ? err.message : "Failed to load wording");
      }

      if (historyResult.status === "fulfilled") {
        setHistory(historyResult.value);
      } else {
        const err = historyResult.reason;
        setLoadErr(err instanceof Error ? err.message : "Failed to load wording history");
      }
    } catch (ex) {
      setLoadErr(ex instanceof Error ? ex.message : "Failed to load wording");
    } finally {
      setLoading(false);
    }
  }

  // Runs when isAdmin flips true; load() reads form state only as a mount-time
  // guard (don't clobber in-progress edits), so it must not be a dependency.
  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formMarkdown.trim()) {
      setMsg("Markdown content is required.");
      setMsgOk(false);
      return;
    }
    const nextVersion = (active?.version ?? 0) + 1;
    if (!window.confirm(`Publish version ${nextVersion}? Pilots will need to re-accept on next sign-to-fly.`)) {
      return;
    }

    setBusy(true);
    setMsg(null);
    try {
      await api.post("manage/sign-to-fly/wording", {
        markdown: formMarkdown,
      });
      setMsg(`Version ${nextVersion} published successfully.`);
      setMsgOk(true);
      await load();
    } catch (ex) {
      setMsg(ex instanceof Error ? ex.message : "Failed to publish");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || loading) return <LoadingSpinner message="Loading wording…" />;
  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;
  if (loadErr) return <div style={{ padding: "0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem" }}>{loadErr}</div>;

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Sign-to-fly Wording</h1>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "1.5rem" }}>
        <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "1rem" }}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Currently active (version {active?.version ?? "none"})</h2>
          <div 
            data-testid="active-preview"
            style={{ 
              background: "#f8f9fa", 
              padding: "1rem", 
              borderRadius: "0.3rem",
              border: "1px solid #e9ecef",
              fontSize: "0.9rem"
            }}
          >
            {active ? <MarkdownView markdown={active.markdown} /> : <em>No active wording</em>}
          </div>
        </div>

        <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "1rem" }}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Version history</h2>
          {history.length === 0 ? (
            <p style={{ fontSize: "0.9rem", color: "#666" }}>No history.</p>
          ) : (
            <table style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.25rem" }}>Version</th>
                  <th style={{ padding: "0.25rem" }}>Published</th>
                  <th style={{ padding: "0.25rem" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.version} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.35rem 0.25rem" }}>{h.version}</td>
                    <td style={{ padding: "0.35rem 0.25rem" }}>{new Date(h.lastModified).toLocaleDateString()}</td>
                    <td style={{ padding: "0.35rem 0.25rem" }}>
                      {h.version === active?.version ? (
                        <span style={{ background: "#d1e7dd", color: "#0f5132", padding: "0.1rem 0.4rem", borderRadius: "1rem", fontSize: "0.75rem" }}>Active</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "1rem", marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Publish new version</h2>
        
        <form onSubmit={(e) => { void handleSubmit(e); }}>
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ fontSize: "0.85rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>Markdown Content</label>
            <p style={{ fontSize: "0.8rem", color: "#666", margin: "0 0 0.5rem 0" }}>Displayed to users during sign-to-fly.</p>
            <MarkdownEditor
              value={formMarkdown}
              onChange={(v) => setFormMarkdown(v ?? "")}
              preview="edit"
            />
          </div>

          <div style={{ marginBottom: "1.5rem" }}>
            <label style={{ fontSize: "0.85rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>Live preview</label>
            <div 
              data-testid="live-preview"
              style={{ 
                background: "#f8f9fa", 
                padding: "1rem", 
                borderRadius: "0.3rem",
                border: "1px solid #e9ecef",
                fontSize: "0.9rem"
              }}
            >
              <MarkdownView markdown={formMarkdown} />
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}>
              {busy ? "Publishing…" : `Publish Version ${(active?.version ?? 0) + 1}`}
            </button>
            {msg && <Banner msg={msg} ok={msgOk} />}
          </div>
        </form>
      </div>
    </div>
  );
}
