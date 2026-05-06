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

  const inputCls =
    "w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20";

  return (
    <main className="flex min-h-[calc(100vh-3rem)] items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="flex bg-slate-800 rounded-full p-1 mb-6">
          {(["login", "register"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(null); }}
              className={[
                "flex-1 rounded-full py-2 text-sm font-semibold transition-colors cursor-pointer border-0",
                tab === t
                  ? "bg-gradient-to-r from-violet-700 to-pink-500 text-white"
                  : "text-slate-400 hover:text-white bg-transparent",
              ].join(" ")}
            >
              {t === "login" ? "Sign In" : "Register"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-[10px] text-slate-500 uppercase tracking-widest mb-1">
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
              className={inputCls}
              placeholder="your_handle"
            />
          </div>

          <div>
            <label className="block text-[10px] text-slate-500 uppercase tracking-widest mb-1">
              Passphrase
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
              minLength={6}
              autoComplete={tab === "login" ? "current-password" : "new-password"}
              className={inputCls}
              placeholder="correct horse battery staple"
            />
          </div>

          {error && (
            <p className="rounded-xl bg-red-950/50 border border-red-900/50 px-4 py-2.5 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="py-2.5 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-violet-700 to-pink-500 disabled:opacity-50 cursor-pointer border-0"
          >
            {loading ? "Please wait…" : tab === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>

      </div>
    </main>
  );
}
