import type { Socket } from "socket.io-client";
import type {
  GpsPoint,
  SencropHourlyRow,
  SencropRawData,
  WeatherSummary,
  WeatherSummaryRequest,
} from "./api";

// Événements Socket.IO des clients navigateur (server/src/socket.rs).

export interface ServerToClientEvents {
  getPlan: (src: string | null) => void;
  location_update: (point: GpsPoint) => void;
  getDataR1: (data: SencropHourlyRow[], measures: string) => void;
  getDataR2: (data: SencropRawData, measures: string) => void;
  getDataW1: (data: SencropHourlyRow[], measures: string) => void;
  getDataW2: (data: SencropRawData, measures: string) => void;
  getWeatherSummary: (summary: WeatherSummary) => void;
}

export interface ClientToServerEvents {
  askPlan: (year: number) => void;
  askDataR1: (date: string, measures: string) => void;
  askDataR2: (date: string, measures: string) => void;
  askDataW1: (date: string, measures: string) => void;
  askDataW2: (date: string, measures: string) => void;
  askWeatherSummary: (request: WeatherSummaryRequest) => void;
}

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
