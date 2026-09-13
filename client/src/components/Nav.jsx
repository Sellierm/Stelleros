import { useState, useEffect } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./Nav.css";

export default function Nav() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Theme state
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // Check initial preference from localStorage or system
    const savedTheme = localStorage.getItem("theme");
    const systemPrefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;

    if (savedTheme === "dark" || (!savedTheme && systemPrefersDark)) {
      setIsDark(true);
      document.documentElement.classList.add("dark-theme");
    } else {
      setIsDark(false);
      document.documentElement.classList.remove("dark-theme");
    }
  }, []);

  const toggleTheme = () => {
    setIsDark((prev) => {
      const newDark = !prev;
      if (newDark) {
        document.documentElement.classList.add("dark-theme");
        localStorage.setItem("theme", "dark");
      } else {
        document.documentElement.classList.remove("dark-theme");
        localStorage.setItem("theme", "light");
      }
      return newDark;
    });
  };

  // Get current page name for the logo (matches original navname)
  const pageNames = {
    "/forecast": "Forecast",
    "/sencrop": "Sencrop",
    "/fields": "Fields",
    "/gps": "Gps",
    "/phyto": "Phyto",
  };
  const currentName = pageNames[location.pathname] || "Farm";

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  // Match original: active link gets 'highlight' class
  const linkClass = ({ isActive }) => (isActive ? "link highlight" : "link");

  return (
    <header>
      <h1 id="logo">{currentName}</h1>
      <nav>
        <ul className="nav_links">
          <li>
            <NavLink className={linkClass} to="/forecast">
              Forecast
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/sencrop">
              Sencrop
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/fields">
              Fields
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/gps">
              Gps
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/phyto">
              Phyto
            </NavLink>
          </li>
        </ul>
      </nav>
      <div
        className="nav-actions"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginRight: "1vw",
        }}
      >
        <label className="theme-switch" title="Basculer le thème">
          <input type="checkbox" checked={isDark} onChange={toggleTheme} />
          <span className="slider">
            <svg
              className="slider-icon sun-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
            >
              <path d="M12 2.25a.75.75 0 0 1 .75.75v2.25a.75.75 0 0 1-1.5 0V3a.75.75 0 0 1 .75-.75zM7.5 12a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0zM18.825 5.175a.75.75 0 0 1 1.06 1.06l-1.59 1.59a.75.75 0 1 1-1.06-1.06l1.59-1.59zM21.75 12a.75.75 0 0 1-.75.75h-2.25a.75.75 0 0 1 0-1.5h2.25a.75.75 0 0 1 .75.75zM17.765 17.765a.75.75 0 0 1 0 1.06l-1.59 1.59a.75.75 0 0 1-1.06-1.06l1.59-1.59a.75.75 0 0 1 1.06 0zM12 18.75a.75.75 0 0 1 .75.75v2.25a.75.75 0 0 1-1.5 0v-2.25a.75.75 0 0 1 .75-.75zM5.175 18.825a.75.75 0 0 1-1.06-1.06l1.59-1.59a.75.75 0 1 1 1.06 1.06l-1.59 1.59zM2.25 12a.75.75 0 0 1 .75-.75h2.25a.75.75 0 0 1 0 1.5H3a.75.75 0 0 1-.75-.75zM6.235 6.235a.75.75 0 0 1 0-1.06l1.59-1.59a.75.75 0 1 1 1.06 1.06L7.295 6.235a.75.75 0 0 1-1.06 0z" />
            </svg>
            <svg
              className="slider-icon moon-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
            >
              <path d="M21.64 13a1 1 0 0 0-1.05-.14 8.05 8.05 0 0 1-3.37.73A8.15 8.15 0 0 1 9.08 5.49a8.59 8.59 0 0 1 .25-2A1 1 0 0 0 8 2.36 10.14 10.14 0 1 0 22 14.05a1 1 0 0 0-.36-1.05zm-9.5 6.64a8.14 8.14 0 0 1-2.45-15.82A10.15 10.15 0 0 0 19.38 15a8.16 8.16 0 0 1-7.24 4.64z" />
            </svg>
          </span>
        </label>
        <a
          className="cta"
          id="deco"
          href="#"
          style={{ marginRight: 0 }}
          onClick={(e) => {
            e.preventDefault();
            handleLogout();
          }}
        >
          Log out
        </a>
      </div>
    </header>
  );
}
