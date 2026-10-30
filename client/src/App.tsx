import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { SocketProvider } from "./contexts/SocketContext";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginPage from "./pages/LoginPage";
import ForecastPage from "./pages/ForecastPage";
import SencropPage from "./pages/SencropPage";
import FieldsPage from "./pages/FieldsPage";
import GpsPage from "./pages/GpsPage";
import PhytoPage from "./pages/PhytoPage";

export default function App() {
  const homePage = import.meta.env.DEV ? (
    <Navigate to="/forecast" replace />
  ) : (
    <LoginPage />
  );

  return (
    <AuthProvider>
      <SocketProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={homePage} />
            <Route
              path="/forecast"
              element={
                <ProtectedRoute>
                  <ForecastPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sencrop"
              element={
                <ProtectedRoute>
                  <SencropPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/fields"
              element={
                <ProtectedRoute>
                  <FieldsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/gps"
              element={
                <ProtectedRoute>
                  <GpsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/phyto"
              element={
                <ProtectedRoute>
                  <PhytoPage />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </SocketProvider>
    </AuthProvider>
  );
}
