import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { io } from "socket.io-client";
import { useAuth } from "./AuthContext";
import type { AppSocket } from "../types/socket";

const SocketContext = createContext<AppSocket | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<AppSocket | null>(null);
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

    const s: AppSocket = io({
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
