// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from "react";
import * as z from "zod/v4";
import { Link, useNavigate } from "react-router";
import type { AdminUserView, ClubSummary, Pilot, UserRole } from "@bccweb/types";
import { ClubSummarySchema } from "@bccweb/schemas";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
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

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#555",
  display: "block",
  marginBottom: "0.2rem",
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

function UserEditRow({
  user,
  clubs,
  onRefresh,
}: {
  user: AdminUserView;
  clubs: ClubSummary[];
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(user.email);
  const [emailVerified, setEmailVerified] = useState(user.emailVerified);
  const [roles, setRoles] = useState<Set<UserRole>>(() => new Set(user.roles));
  const [clubId, setClubId] = useState(user.clubId ?? "");
  const [showPilotForm, setShowPilotForm] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);

  // Keep the verified badge / Verify button in sync when the parent re-fetches
  // after a mutation (e.g. force-verify below flips this to true).
  useEffect(() => {
    setEmailVerified(user.emailVerified);
  }, [user.emailVerified]);

  function toggleRole(role: UserRole) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  async function saveEmail() {
    setBusy(true);
    setMsg(null);
    try {
      const updated = await api.put<AdminUserView>(`manage/users/${user.id}/email`, { email });
      // Changing the email resets verification server-side — reflect it locally
      // so the Verify button appears without a full page refresh.
      setEmail(updated.email);
      setEmailVerified(updated.emailVerified);
      setMsg("Email updated. The user has been signed out and emailed a verification link at the new address. You can also verify manually below.");
      setMsgOk(true);
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === "EMAIL_TAKEN") {
        setMsg("Email already in use.");
      } else {
        setMsg(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Failed to update email");
      }
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function verifyEmail() {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`manage/users/${user.id}/verify-email`);
      // Flip the badge directly: after an email edit the parent prop is still
      // `true`, so the `[user.emailVerified]` sync effect won't re-fire on refresh.
      setEmailVerified(true);
      onRefresh();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Failed to verify email");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles() {
    setBusy(true);
    setMsg(null);
    try {
      // Send ONLY roles + clubId; pilotId is managed via the pilot control below
      // and must stay untouched here.
      await api.put(`manage/users/${user.id}/roles`, {
        roles: Array.from(roles),
        clubId: clubId || null,
      });
      setMsg("Saved.");
      setMsgOk(true);
      onRefresh();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Failed to save roles");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function createPilot(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const resp = await api.post<{ pilot: Pilot }>(`manage/users/${user.id}/pilot`, { firstName, lastName });
      navigate(`/pilots/${resp.pilot.id}`);
    } catch (ex) {
      setMsg(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Failed to create pilot profile");
      setMsgOk(false);
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete the account for ${user.email}? This removes their login only; the linked pilot record is kept.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.delete(`manage/users/${user.id}`);
      onRefresh();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Delete failed");
      setMsgOk(false);
      setBusy(false);
    }
  }

  return (
    <div style={{ borderBottom: "1px solid #f0f0f0", padding: "0.6rem 0" }}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <span style={{ flex: 1, fontSize: "0.9rem" }}>
          <strong>{user.email}</strong>
          <span style={{
            marginLeft: "0.5rem",
            fontSize: "0.7rem",
            fontWeight: 600,
            padding: "0.1rem 0.45rem",
            borderRadius: "0.75rem",
            background: emailVerified ? "#d1e7dd" : "#fff3cd",
            color: emailVerified ? "#0a3622" : "#664d03",
          }}>
            {emailVerified ? "Verified" : "Unverified"}
          </span>
        </span>
        <button style={btnStyle("#333", "#e9ecef")} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          {/* (a) Editable email + Save email */}
          <div>
            <label htmlFor={`email-${user.id}`} style={labelStyle}>Email</label>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <input
                id={`email-${user.id}`}
                type="email"
                style={{ ...inputStyle, minWidth: 240, flex: 1 }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => { void saveEmail(); }}
                style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
              >
                Save email
              </button>
            </div>
          </div>

          {/* (b) Verify email — rendered only while unverified */}
          {!emailVerified && (
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => { void verifyEmail(); }}
                style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}
              >
                Verify email
              </button>
            </div>
          )}

          {/* (c) Roles + Admin club + Save */}
          <div>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
              {ALL_ROLES.map((role) => (
                <label key={role} style={{ display: "flex", gap: "0.3rem", alignItems: "center", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={roles.has(role)}
                    onChange={() => toggleRole(role)}
                  />
                  {role}
                </label>
              ))}
            </div>
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <label htmlFor={`club-${user.id}`} style={labelStyle}>Admin club</label>
                <select
                  id={`club-${user.id}`}
                  style={{ ...inputStyle, width: 240 }}
                  value={clubId}
                  onChange={(e) => setClubId(e.target.value)}
                >
                  <option value="">(none)</option>
                  {clubs.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => { void saveRoles(); }}
                style={btnStyle("#fff", busy ? "#6c757d" : "#0066cc")}
              >
                Save
              </button>
            </div>
          </div>

          {/* (d) Pilot ID — read-only */}
          <div>
            <span style={labelStyle}>Pilot ID</span>
            <div style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "#333" }}>
              {user.pilotId ?? "(none)"}
            </div>
          </div>

          {/* (e) Pilot profile control */}
          <div>
            {user.pilotId ? (
              <Link to={`/pilots/${user.pilotId}`} style={{ color: "#0066cc", fontSize: "0.85rem" }}>
                Edit pilot profile
              </Link>
            ) : showPilotForm ? (
              <form
                onSubmit={(e) => { void createPilot(e); }}
                style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}
              >
                <div>
                  <label htmlFor={`fn-${user.id}`} style={labelStyle}>First name</label>
                  <input
                    id={`fn-${user.id}`}
                    required
                    style={inputStyle}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor={`ln-${user.id}`} style={labelStyle}>Last name</label>
                  <input
                    id={`ln-${user.id}`}
                    required
                    style={inputStyle}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
                <button type="submit" disabled={busy} style={btnStyle("#fff", busy ? "#6c757d" : "#0a6640")}>
                  Create
                </button>
              </form>
            ) : (
              <button type="button" onClick={() => setShowPilotForm(true)} style={btnStyle("#333", "#e9ecef")}>
                Create pilot profile
              </button>
            )}
          </div>

          {/* (f) Delete */}
          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: "0.75rem" }}>
            <p style={{ fontSize: "0.75rem", color: "#666", margin: "0 0 0.5rem" }}>
              Deleting removes the login only; the pilot record is kept (unlinked). Full data erasure follows the GDPR runbook (docs/runbooks/gdpr-erasure.md).
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => { void handleDelete(); }}
              style={btnStyle("#fff", busy ? "#6c757d" : "#b02a37")}
            >
              Delete
            </button>
          </div>

          {msg && <Banner msg={msg} ok={msgOk} />}
        </div>
      )}
    </div>
  );
}

export default function AdminUsers() {
  const { identity, loading: authLoading } = useAuth();
  const [refresh, setRefresh] = useState(0);
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Clubs for the "Admin club" dropdown — public blob, no auth needed.
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json", z.array(ClubSummarySchema));

  const isAdmin = identity?.roles.includes("Admin") ?? false;

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Users are PRIVATE (PII) — fetch through the authenticated API, never useBlob.
    api
      .get<AdminUserView[]>("manage/users")
      .then((data) => {
        if (!cancelled) {
          setUsers(data);
          setError(null);
        }
      })
      .catch((ex: unknown) => {
        if (!cancelled) setError(ex instanceof Error ? ex.message : "Failed to load users");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, refresh]);

  if (authLoading || loading) return <LoadingSpinner message="Loading users…" />;
  if (!isAdmin) {
    return <p style={{ color: "#721c24" }}>Admin access required.</p>;
  }
  if (error) {
    return <div style={{ padding: "0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem" }}>{error}</div>;
  }

  const clubList = clubs ?? [];
  const sortedUsers = users.slice().sort((a, b) => a.email.localeCompare(b.email));

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Users & Pilots</h1>

      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "0.75rem 1rem" }}>
        {sortedUsers.length === 0 && (
          <p style={{ color: "#888", fontSize: "0.85rem", margin: "0.25rem 0" }}>No users found.</p>
        )}
        {sortedUsers.map((u) => (
          <UserEditRow
            key={u.id}
            user={u}
            clubs={clubList}
            onRefresh={() => setRefresh((v) => v + 1)}
          />
        ))}
      </div>
    </div>
  );
}
