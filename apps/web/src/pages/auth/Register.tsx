import { useState } from "react";
import { Link } from "react-router-dom";
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

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("auth/register", { email, password });
      setDone(true);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Check your email</h1>
        <p style={{ color: "#0a3622", background: "#d1e7dd", padding: "0.75rem", borderRadius: "0.3rem", fontSize: "0.9rem" }}>
          A verification link has been sent to <strong>{email}</strong>. Please check your inbox and click the link to activate your account.
        </p>
        <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          <Link to="/login" style={{ color: "#0066cc" }}>Back to sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Create account</h1>

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
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem", color: "#555" }}>
            Password <span style={{ color: "#888", fontWeight: 400 }}>(min. 8 characters)</span>
          </label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            style={inputStyle}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem", color: "#555" }}>
            Confirm password
          </label>
          <input
            type="password"
            required
            autoComplete="new-password"
            style={inputStyle}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error && (
          <div style={{ padding: "0.5rem 0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem", fontSize: "0.85rem" }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={busy} style={{ ...btnStyle, background: busy ? "#6c757d" : "#0066cc" }}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p style={{ marginTop: "1.5rem", fontSize: "0.85rem", color: "#555" }}>
        Already have an account?{" "}
        <Link to="/login" style={{ color: "#0066cc" }}>Sign in</Link>
      </p>
    </div>
  );
}
