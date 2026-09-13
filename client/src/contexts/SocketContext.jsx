import { createContext, useContext, useEffect, useState } from "react";
import { io } from "socket.io-client";
import { useAuth } from "./AuthContext.jsx";

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const [socket, setSocket] = useState(null);
  const { authenticated, loading } = useAuth();

  const usePollingOnly =
    import.meta.env.PROD || import.meta.env.VITE_SOCKET_POLLING_ONLY === "true";

  useEffect(() => {
    if (loading) return;

    if (!authenticated) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    const s = io({
      withCredentials: true,
      transports: usePollingOnly ? ["polling"] : ["websocket", "polling"],
    });
    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, loading]);

  return (
    <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
