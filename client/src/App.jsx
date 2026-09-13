import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext.jsx";
import { SocketProvider } from "./contexts/SocketContext.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import ForecastPage from "./pages/ForecastPage.jsx";
import SencropPage from "./pages/SencropPage.jsx";
import FieldsPage from "./pages/FieldsPage.jsx";
import GpsPage from "./pages/GpsPage.jsx";
import PhytoPage from "./pages/PhytoPage.jsx";

export default function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LoginPage />} />
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
