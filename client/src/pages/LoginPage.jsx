import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import "./LoginPage.css";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { login, authenticated } = useAuth();
  const navigate = useNavigate();

  usePageMeta("Login", "/assets/icons8-connexion-32.png");

  // Load Font Awesome (matches original <head> link)
  useEffect(() => {
    if (!document.querySelector('link[href*="fontawesome"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://use.fontawesome.com/releases/v5.7.1/css/all.css";
      document.head.appendChild(link);
    }
  }, []);

  // Already logged in → go to forecast
  if (authenticated) {
    navigate("/forecast");
    return null;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const result = await login(username, password);
    if (result.success) {
      navigate("/forecast");
    } else {
      setError(result.message || "Wrong username/password combination");
      setUsername("");
      setPassword("");
    }
  };

  return (
    <div className="login-bg">
      <div className="login">
        <h1>Login</h1>
        <form onSubmit={handleSubmit}>
          <label htmlFor="username">
            <i className="fas fa-user" />
          </label>
          <input
            type="text"
            id="username"
            name="username"
            placeholder="Username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <label htmlFor="password">
            <i className="fas fa-lock" />
          </label>
          <input
            type="password"
            id="password"
            name="password"
            placeholder="Password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id="error">{error}</p>
          <input type="submit" value="Login" />
        </form>
      </div>
    </div>
  );
}
