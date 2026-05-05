import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { decodeJwt } from "jose";

interface AuthUser {
  id: string;
  username: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  login: (token: string, username: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  login: () => {},
  logout: () => {},
});

const STORAGE_KEY = "cab_token";

function parseToken(token: string): AuthUser | null {
  try {
    const payload = decodeJwt(token);
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (!payload.sub || !payload.username) return null;
    return { id: payload.sub as string, username: payload.username as string };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = parseToken(stored);
      if (parsed) {
        setToken(stored);
        setUser(parsed);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  function login(newToken: string, username: string) {
    localStorage.setItem(STORAGE_KEY, newToken);
    setToken(newToken);
    setUser({ id: parseToken(newToken)?.id ?? "", username });
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
