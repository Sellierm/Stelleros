import { createContext, useContext, type ReactNode } from "react";
import { authClient } from "../lib/authClient";

type LoginResult = { success: true } | { success: false; message: string };

interface AuthContextValue {
  authenticated: boolean;
  username: string;
  loading: boolean;
  csrfToken: string;
  refreshCsrfToken: () => Promise<string>;
  login: (user: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isPending } = authClient.useSession();
  const devBypassAuth = import.meta.env.DEV;

  const login = async (
    user: string,
    password: string,
  ): Promise<LoginResult> => {
    const { error } = await authClient.signIn.username({
      username: user,
      password,
    });
    if (error) {
      return {
        success: false,
        message: error.message || "Wrong username/password combination",
      };
    }
    return { success: true };
  };

  const logout = async () => {
    await authClient.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        authenticated: devBypassAuth || !!data?.user,
        username: data?.user?.username || "",
        loading: devBypassAuth ? false : isPending,
        csrfToken: "",
        refreshCsrfToken: async () => "",
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth doit être appelé sous AuthProvider");
  return auth;
};
