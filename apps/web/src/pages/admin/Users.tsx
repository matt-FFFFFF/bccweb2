import { useEffect, useState } from "react";
import type { ClubSummary, User, UserRole } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api } from "../../lib/api.js";
import { useBlob } from "../../hooks/useBlob.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

const ALL_ROLES: UserRole[] = ["Admin", "RoundsCoord", "Pilot"];

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.85rem",
  boxSizing: "border-box",
};

const btnStyle = (color: string, bg: string): React.CSSProperties => ({
  padding: "0.3rem 0.6rem",
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
      marginTop: "0.25rem",
    }}>
      {msg}
    </div>
  );
}

interface UserRow extends User {
  editPilotId: string;
  editClubId: string;
  editRoles: Set<UserRole>;
  busy: boolean;
  msg: string | null;
  msgOk: boolean;
}

export default function AdminUsers() {
  const { identity, loading: authLoading } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load clubs for the dropdown — public blob, no auth needed
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json");

  const isAdmin = identity?.roles.includes("Admin");

  useEffect(() => {
    if (!isAdmin) return;
    async function load() {
      try {
        const data = await api.get<User[]>("manage/users");
        setUsers(
          data.map((u) => ({
            ...u,
            editPilotId: u.pilotId ?? "",
            editClubId: u.clubId ?? "",
            editRoles: new Set(u.roles),
            busy: false,
            msg: null,
            msgOk: false,
          }))
        );
      } catch (ex) {
        setError(ex instanceof Error ? ex.message : "Failed to load users");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [isAdmin]);

  function toggleRole(userId: string, role: UserRole) {
    setUsers((prev) =>
      prev.map((u) => {
        if (u.id !== userId) return u;
        const next = new Set(u.editRoles);
        if (next.has(role)) next.delete(role);
        else next.add(role);
        return { ...u, editRoles: next };
      })
    );
  }

  async function save(userId: string) {
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, busy: true, msg: null } : u));
    const row = users.find((u) => u.id === userId)!;
    try {
      await api.put(`manage/users/${userId}/roles`, {
        roles: Array.from(row.editRoles),
        pilotId: row.editPilotId || null,
        clubId: row.editClubId || null,
      });
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? { ...u, busy: false, msg: "Saved.", msgOk: true, roles: Array.from(row.editRoles) as UserRole[] }
            : u
        )
      );
    } catch (ex) {
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? { ...u, busy: false, msg: ex instanceof Error ? ex.message : "Failed", msgOk: false }
            : u
        )
      );
    }
  }

  if (authLoading || loading) return <LoadingSpinner message="Loading users…" />;
  if (!isAdmin) {
    return <p style={{ color: "#721c24" }}>Admin access required.</p>;
  }
  if (error) {
    return <div style={{ padding: "0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem" }}>{error}</div>;
  }

  const clubList = clubs ?? [];

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>User Management</h1>

      {users.length === 0 && <p style={{ color: "#888" }}>No users found.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {users.map((u) => (
          <div
            key={u.id}
            style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "0.75rem 1rem" }}
          >
            <div style={{ marginBottom: "0.5rem" }}>
              <strong style={{ fontSize: "0.9rem" }}>{u.email}</strong>
              <span style={{ marginLeft: "0.75rem", fontSize: "0.75rem", color: "#888", fontFamily: "monospace" }}>{u.id}</span>
            </div>

            {/* Roles */}
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
              {ALL_ROLES.map((role) => (
                <label key={role} style={{ display: "flex", gap: "0.3rem", alignItems: "center", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={u.editRoles.has(role)}
                    onChange={() => toggleRole(u.id, role)}
                  />
                  {role}
                </label>
              ))}
            </div>

            {/* Pilot ID + Club dropdown */}
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
              <div>
                <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Pilot ID</label>
                <input
                  style={{ ...inputStyle, width: 280 }}
                  placeholder="(none)"
                  value={u.editPilotId}
                  onChange={(e) =>
                    setUsers((prev) =>
                      prev.map((row) => row.id === u.id ? { ...row, editPilotId: e.target.value } : row)
                    )
                  }
                />
              </div>
              <div>
                <label style={{ fontSize: "0.75rem", color: "#555", display: "block" }}>Club</label>
                <select
                  style={{ ...inputStyle, width: 240 }}
                  value={u.editClubId}
                  onChange={(e) =>
                    setUsers((prev) =>
                      prev.map((row) => row.id === u.id ? { ...row, editClubId: e.target.value } : row)
                    )
                  }
                >
                  <option value="">(none)</option>
                  {clubList.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <button
                disabled={u.busy}
                onClick={() => { void save(u.id); }}
                style={btnStyle("#fff", u.busy ? "#6c757d" : "#0066cc")}
              >
                {u.busy ? "Saving…" : "Save"}
              </button>
              {u.msg && <Banner msg={u.msg} ok={u.msgOk} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
