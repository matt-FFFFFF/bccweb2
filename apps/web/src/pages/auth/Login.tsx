import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth, AuthError } from "../../hooks/useAuth.js";
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

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResend, setShowResend] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setShowResend(false);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (ex) {
      if (ex instanceof AuthError && ex.code === "EMAIL_NOT_VERIFIED") {
        setShowResend(true);
        setError("Your email address has not been verified. Check your inbox or resend the verification email.");
      } else {
        setError(ex instanceof Error ? ex.message : "Login failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setResendBusy(true);
    setResendMsg(null);
    try {
      await api.post("auth/resend-verification", { email });
      setResendMsg("Verification email sent. Check your inbox.");
    } catch (ex) {
      setResendMsg(ex instanceof Error ? ex.message : "Failed to resend");
    } finally {
      setResendBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Sign in</h1>

      <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label htmlFor="login-email" style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem", color: "#555" }}>
            Email address
          </label>
          <input
            id="login-email"
            type="email"
            required
            autoComplete="username"
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="login-password" style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem", color: "#555" }}>
            Password
          </label>
          <input
            id="login-password"
            type="password"
            required
            autoComplete="current-password"
            style={inputStyle}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <div style={{ padding: "0.5rem 0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem", fontSize: "0.85rem" }}>
            {error}
            {showResend && (
              <div style={{ marginTop: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => { void handleResend(); }}
                  disabled={resendBusy}
                  style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", padding: 0, fontSize: "0.85rem", textDecoration: "underline" }}
                >
                  {resendBusy ? "Sending…" : "Resend verification email"}
                </button>
                {resendMsg && <span style={{ marginLeft: "0.5rem", color: "#0a3622" }}>{resendMsg}</span>}
              </div>
            )}
          </div>
        )}

        <button type="submit" disabled={busy} style={{ ...btnStyle, background: busy ? "#6c757d" : "#0066cc" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div style={{ marginTop: "1.5rem", fontSize: "0.85rem", color: "#555", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <Link to="/forgot-password" style={{ color: "#0066cc" }}>Forgot your password?</Link>
        <span>
          Don't have an account?{" "}
          <Link to="/register" style={{ color: "#0066cc" }}>Register</Link>
        </span>
      </div>
    </div>
  );
}
