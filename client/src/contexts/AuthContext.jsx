import { createContext, useContext, useState, useEffect } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [loading, setLoading] = useState(true); // check session on mount

  const refreshCsrfToken = async () => {
    const res = await fetch("/api/csrf-token", { credentials: "include" });
    const data = await res.json();
    if (data.csrfToken) {
      setCsrfToken(data.csrfToken);
      return data.csrfToken;
    }
    return "";
  };

  useEffect(() => {
    fetch("/api/check-auth", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          setAuthenticated(true);
          setUsername(data.username);
        }
        if (data.csrfToken) {
          setCsrfToken(data.csrfToken);
        }
      })
      .catch(() => {})
      .finally(async () => {
        if (!csrfToken) {
          try {
            await refreshCsrfToken();
          } catch (error) {
            console.error("Unable to initialize CSRF token", error);
          }
        }
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (user, password) => {
    const token = csrfToken || (await refreshCsrfToken());
    const res = await fetch("/api/auth", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": token,
      },
      body: JSON.stringify({ username: user, password }),
    });
    const data = await res.json();
    if (data.success) {
      setAuthenticated(true);
      setUsername(user);
      if (data.csrfToken) {
        setCsrfToken(data.csrfToken);
      }
      return { success: true };
    }
    return {
      success: false,
      message: data.message || "Wrong username/password combination",
    };
  };

  const logout = async () => {
    const token = csrfToken || (await refreshCsrfToken());
    await fetch("/api/logout", {
      method: "POST",
      credentials: "include",
      headers: {
        "x-csrf-token": token,
      },
    });
    setAuthenticated(false);
    setUsername("");
    await refreshCsrfToken();
  };

  return (
    <AuthContext.Provider
      value={{
        authenticated,
        username,
        loading,
        csrfToken,
        refreshCsrfToken,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
