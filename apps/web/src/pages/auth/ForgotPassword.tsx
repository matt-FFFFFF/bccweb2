// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../lib/api.js";

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.9rem",
  width: "100%",
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  padding: "0.45rem 1.25rem",
  background: "#0066cc",
  color: "#fff",
  border: "none",
  borderRadius: "0.3rem",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.9rem",
  width: "100%",
};

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("auth/forgot-password", { email });
      // Always show success to avoid email enumeration
      setDone(true);
    } catch (ex) {
      // Still show success message to prevent email enumeration
      console.error(ex);
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Check your email</h1>
        <p style={{ color: "#0a3622", background: "#d1e7dd", padding: "0.75rem", borderRadius: "0.3rem", fontSize: "0.9rem" }}>
          If an account exists for <strong>{email}</strong>, a password reset link has been sent. Check your inbox.
        </p>
        <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          <Link to="/login" style={{ color: "#0066cc" }}>Back to sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Forgot password</h1>
      <p style={{ color: "#555", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
        Enter your email address and we'll send you a reset link.
      </p>

      <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem", color: "#555" }}>
            Email address
          </label>
          <input
            type="email"
            required
            autoComplete="username"
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        {error && (
          <div style={{ padding: "0.5rem 0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem", fontSize: "0.85rem" }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={busy} style={{ ...btnStyle, background: busy ? "#6c757d" : "#0066cc" }}>
          {busy ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <p style={{ marginTop: "1.5rem", fontSize: "0.85rem", color: "#555" }}>
        <Link to="/login" style={{ color: "#0066cc" }}>Back to sign in</Link>
      </p>
    </div>
  );
}
