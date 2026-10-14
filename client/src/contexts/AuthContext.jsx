import { createContext, useContext } from "react";
import { authClient } from "../lib/authClient.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const { data, isPending } = authClient.useSession();

  const login = async (user, password) => {
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
        authenticated: !!data?.user,
        username: data?.user?.username || "",
        loading: isPending,
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

export const useAuth = () => useContext(AuthContext);
