import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";

export const Route = createFileRoute("/auth")({ component: AuthScreen });

function AuthScreen() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const url = tab === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, passphrase }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }
      login(data.token, data.username);
      navigate({ to: "/" });
    } catch {
      setError("Network error, please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-bold text-[var(--sea-ink)]">
          Cards Against Bhayanak
        </h1>

        <div className="mb-6 flex rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.08)] p-1">
          {(["login", "register"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(null); }}
              className={`flex-1 rounded-full py-2 text-sm font-semibold transition ${
                tab === t
                  ? "bg-[var(--lagoon-deep)] text-white shadow"
                  : "text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
              }`}
            >
              {t === "login" ? "Sign In" : "Register"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--sea-ink)]">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={1}
              maxLength={32}
              autoComplete="username"
              className="w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-white/60 px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none focus:border-[var(--lagoon-deep)] focus:ring-2 focus:ring-[rgba(79,184,178,0.3)]"
              placeholder="your_handle"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--sea-ink)]">
              Passphrase
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
              minLength={6}
              autoComplete={tab === "login" ? "current-password" : "new-password"}
              className="w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-white/60 px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none focus:border-[var(--lagoon-deep)] focus:ring-2 focus:ring-[rgba(79,184,178,0.3)]"
              placeholder="correct horse battery staple"
            />
          </div>

          {error && (
            <p className="rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-full bg-[var(--lagoon-deep)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60"
          >
            {loading ? "Please wait…" : tab === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>
      </div>
    </main>
  );
}
