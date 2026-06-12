import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import * as z from "zod/v4";
import type { ClubSummary, Pilot } from "@bccweb/types";
import { ClubSummarySchema } from "@bccweb/schemas";
import { useAuth } from "../hooks/useAuth.js";
import { useBlob } from "../hooks/useBlob.js";
import { api, ApiError } from "../lib/api.js";
import { LoadingSpinner } from "../components/LoadingSpinner.js";

const inputStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.9rem",
  boxSizing: "border-box",
  width: "100%",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.78rem",
  color: "#555",
  marginBottom: "0.25rem",
  fontWeight: 600,
};

interface CreateForm {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  currentClubId: string;
  bhpaNumber: string;
  emergencyContactName: string;
  emergencyPhoneNumber: string;
}

const emptyForm: CreateForm = {
  firstName: "",
  lastName: "",
  phoneNumber: "",
  currentClubId: "",
  bhpaNumber: "",
  emergencyContactName: "",
  emergencyPhoneNumber: "",
};

export default function Profile() {
  const { identity, loading, refreshIdentity } = useAuth();
  const navigate = useNavigate();
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json", z.array(ClubSummarySchema));

  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <LoadingSpinner message="Loading…" />;
  if (!identity) return <Navigate to="/login?return=/profile" replace />;
  if (identity.pilotId) {
    return <Navigate to={`/pilots/${identity.pilotId}`} replace />;
  }

  function setF<K extends keyof CreateForm>(k: K, v: CreateForm[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    setBusy(true);
    try {
      const selectedClub = clubs?.find((c) => c.id === form.currentClubId);
      const created = await api.post<Pilot>("me/pilot", {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phoneNumber: form.phoneNumber.trim() || undefined,
        bhpaNumber: form.bhpaNumber ? Number(form.bhpaNumber) : undefined,
        emergencyContactName: form.emergencyContactName.trim() || undefined,
        emergencyPhoneNumber: form.emergencyPhoneNumber.trim() || undefined,
        currentClub: selectedClub
          ? { id: selectedClub.id, name: selectedClub.name }
          : undefined,
      });
      await refreshIdentity();
      navigate(`/pilots/${created.id}`, { replace: true });
    } catch (ex) {
      setError(
        ex instanceof ApiError
          ? ex.message
          : ex instanceof Error
            ? ex.message
            : "Failed to create profile"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.6rem", marginTop: 0 }}>Create your pilot profile</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        Signed in as <strong>{identity.email}</strong>. Fill in the basics — you can
        add safety details (wing, harness, emergency contact, medical info) on the
        next screen.
      </p>

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        style={{
          border: "1px solid #dee2e6",
          borderRadius: "0.5rem",
          padding: "1.25rem",
          marginTop: "1rem",
          display: "grid",
          gap: "0.85rem",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
          <div>
            <label style={labelStyle}>First name *</label>
            <input
              style={inputStyle}
              value={form.firstName}
              onChange={(e) => setF("firstName", e.target.value)}
              autoComplete="given-name"
              required
            />
          </div>
          <div>
            <label style={labelStyle}>Last name *</label>
            <input
              style={inputStyle}
              value={form.lastName}
              onChange={(e) => setF("lastName", e.target.value)}
              autoComplete="family-name"
              required
            />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Phone number</label>
          <input
            type="tel"
            style={inputStyle}
            value={form.phoneNumber}
            onChange={(e) => setF("phoneNumber", e.target.value)}
            autoComplete="tel"
          />
        </div>

        <div>
          <label style={labelStyle}>BHPA number</label>
          <input
            type="number"
            min={0}
            style={inputStyle}
            value={form.bhpaNumber}
            onChange={(e) => setF("bhpaNumber", e.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle}>Current club</label>
          <select
            style={inputStyle}
            value={form.currentClubId}
            onChange={(e) => setF("currentClubId", e.target.value)}
          >
            <option value="">— None —</option>
            {clubs?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
          <div>
            <label style={labelStyle}>Emergency contact name</label>
            <input
              style={inputStyle}
              value={form.emergencyContactName}
              onChange={(e) => setF("emergencyContactName", e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle}>Emergency contact phone</label>
            <input
              type="tel"
              style={inputStyle}
              value={form.emergencyPhoneNumber}
              onChange={(e) => setF("emergencyPhoneNumber", e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: "0.5rem 0.7rem",
              borderRadius: "0.3rem",
              background: "#f8d7da",
              color: "#58151c",
              fontSize: "0.85rem",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "0.55rem 1.1rem",
              background: busy ? "#6c757d" : "#0066cc",
              color: "#fff",
              border: "none",
              borderRadius: "0.35rem",
              cursor: busy ? "default" : "pointer",
              fontWeight: 600,
            }}
          >
            {busy ? "Creating…" : "Create profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
