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
import TimesheetPage from "./pages/TimesheetPage";

export default function App() {
  const homePage = import.meta.env.DEV ? (
    <Navigate to="/meteo" replace />
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
              path="/meteo"
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
              path="/champs"
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
            <Route
              path="/pointage"
              element={
                <ProtectedRoute>
                  <TimesheetPage />
                </ProtectedRoute>
              }
            />
            {/* Anciennes adresses (favoris) */}
            <Route
              path="/forecast"
              element={<Navigate to="/meteo" replace />}
            />
            <Route
              path="/fields"
              element={<Navigate to="/champs" replace />}
            />
            <Route
              path="/timesheet"
              element={<Navigate to="/pointage" replace />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </SocketProvider>
    </AuthProvider>
  );
}
