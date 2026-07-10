// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get("token");

  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("No verification token provided.");
      return;
    }

    async function verify() {
      try {
        const res = await fetch(`/api/auth/verify?token=${encodeURIComponent(token!)}`, {
          method: "GET",
        });
        if (res.ok) {
          setStatus("success");
        } else {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          setStatus("error");
          setMessage(body?.error ?? "Verification failed. The link may have expired.");
        }
      } catch {
        setStatus("error");
        setMessage("An error occurred. Please try again.");
      }
    }

    void verify();
  }, [token]);

  if (status === "pending") {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <p style={{ color: "#555" }}>Verifying your email address…</p>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Email verified</h1>
        <p style={{ color: "#0a3622", background: "#d1e7dd", padding: "0.75rem", borderRadius: "0.3rem", fontSize: "0.9rem" }}>
          Your email address has been verified. You can now sign in.
        </p>
        <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          <Link to="/login" style={{ color: "#0066cc" }}>Sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Verification failed</h1>
      <p style={{ padding: "0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem", fontSize: "0.9rem" }}>
        {message ?? "Something went wrong."}
      </p>
      <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
        <Link to="/login" style={{ color: "#0066cc" }}>Back to sign in</Link>
      </p>
    </div>
  );
}
