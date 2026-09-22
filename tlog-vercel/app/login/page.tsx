"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Login failed.");
        setLoading(false);
        return;
      }
      const next = params.get("next") || "/";
      router.push(next);
      router.refresh();
    } catch {
      setError("Connection error - try again.");
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--panel-border)",
          borderRadius: 8,
          padding: "32px 24px",
          width: 320,
          maxWidth: "88vw",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <img src="/mascot.png" alt="Hillcrest Truck Stop" className="login-logo" />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: "var(--text)" }}>Hillcrest Truck Stop</div>
          <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 2 }}>
            Sign in to view live operations
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={inputStyle}
          />
        </label>

        {error && <div style={{ fontSize: 12.5, color: "var(--rose)" }}>{error}</div>}

        <button
          type="submit"
          disabled={loading}
          style={{
            marginTop: 6,
            background: "var(--amber)",
            color: "#1A1000",
            border: "none",
            borderRadius: 6,
            padding: "10px 0",
            fontWeight: 600,
            fontSize: 13.5,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#0A1220",
  border: "1px solid var(--panel-border)",
  borderRadius: 5,
  padding: "9px 10px",
  color: "var(--text)",
  fontSize: 13.5,
  fontFamily: "inherit",
  outline: "none",
};
