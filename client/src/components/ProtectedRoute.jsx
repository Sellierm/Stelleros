import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";

export default function ProtectedRoute({ children }) {
  const { authenticated, loading } = useAuth();

  if (import.meta.env.DEV) {
    return children;
  }

  if (loading) {
    // Wait for session check before redirecting
    return null;
  }

  return authenticated ? children : <Navigate to="/" replace />;
}
