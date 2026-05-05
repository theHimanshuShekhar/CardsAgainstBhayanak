import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, logout } = useAuth();

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />

        <p className="island-kicker mb-3">Cards Against Bhayanak</p>

        {user ? (
          <>
            <h1 className="display-title mb-4 text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
              Welcome back, {user.username}
            </h1>
            <p className="mb-8 max-w-xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
              Ready to be terrible? Create a new game or join one with a room code.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="/game/create"
                className="rounded-full bg-[var(--lagoon-deep)] px-6 py-2.5 text-sm font-semibold text-white no-underline transition hover:-translate-y-0.5"
              >
                Create Game
              </a>
              <a
                href="/game/join"
                className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-6 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
              >
                Join Game
              </a>
              <button
                onClick={logout}
                className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-6 py-2.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:-translate-y-0.5"
              >
                Sign Out
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="display-title mb-4 text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
              Horrible cards. Hilarious people.
            </h1>
            <p className="mb-8 max-w-xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
              A real-time multiplayer card game for people with questionable taste.
              Sign in or create an account to start playing.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="/auth"
                className="rounded-full bg-[var(--lagoon-deep)] px-6 py-2.5 text-sm font-semibold text-white no-underline transition hover:-translate-y-0.5"
              >
                Sign In / Register
              </a>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
