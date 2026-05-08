import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, logout } = useAuth();

  return (
    <main className="flex min-h-[calc(100vh-3rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm flex flex-col gap-8 text-center">

        <div>
          <h1 className="text-5xl font-black bg-gradient-to-r from-orange-500 via-pink-500 to-purple-500 bg-clip-text text-transparent leading-tight mb-3">
            Cards Against<br />Bhayanak
          </h1>
          <p className="text-slate-500 text-sm">
            A party game for horrible people with good Wi-Fi.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {user ? (
            <>
              <Link
                to="/users/$username"
                params={{ username: user.username }}
                className="text-slate-600 text-[10px] uppercase tracking-widest no-underline hover:text-slate-500"
              >
                Signed in as {user.username}
              </Link>
              <Link
                to="/games/create"
                className="block py-3 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-violet-700 to-pink-500 no-underline"
              >
                Create Game
              </Link>
              <Link
                to="/games/join"
                className="block py-3 rounded-xl font-bold text-sm text-violet-400 border border-violet-900/40 no-underline hover:bg-violet-900/20"
              >
                Join Game
              </Link>
              <button
                onClick={logout}
                className="text-[11px] text-slate-700 hover:text-slate-500 bg-transparent border-0 cursor-pointer"
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <Link
                to="/games/create"
                className="block py-3 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-violet-700 to-pink-500 no-underline"
              >
                Create Game
              </Link>
              <Link
                to="/games/join"
                className="block py-3 rounded-xl font-bold text-sm text-violet-400 border border-violet-900/40 no-underline hover:bg-violet-900/20"
              >
                Join Game
              </Link>
              <Link
                to="/auth"
                className="block py-2 text-[11px] text-slate-700 no-underline hover:text-slate-500"
              >
                Sign In / Register
              </Link>
            </>
          )}
        </div>

      </div>
    </main>
  );
}
