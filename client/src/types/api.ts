// Données échangées avec le serveur Rust (server/src). Le serveur renvoie les
// lignes de la base telles quelles : les colonnes nullables restent nullables.

// ─── Configuration ───────────────────────────────────────────

export interface ConfigResponse {
  googleMapsApiKey?: string;
}

// ─── GPS (gps_latest, gps_track, événement location_update) ──

export interface GpsPoint {
  device_id: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  source: string | null;
  timestamp: number;
}

export interface LatestPositionsResponse {
  success: boolean;
  positions?: Record<string, GpsPoint>;
}

export interface PositionsDatesResponse {
  success: boolean;
  dates?: string[];
}

export interface PositionsHistoryResponse {
  success: boolean;
  positions?: Record<
    string,
    {
      // [latitude, longitude, timestamp]
      track?: [number, number, number][];
      last: GpsPoint;
    }
  >;
}

// ─── Phyto ───────────────────────────────────────────────────

export interface Product {
  id: number;
  name: string;
  category: string | null;
  stock: number | null;
  unit: string | null;
  notes: string | null;
}

export interface ApplicationProduct {
  id: number;
  product_id: number;
  product_name: string | null;
  quantity_used: number | null;
}

export interface Application {
  id: number;
  date: string;
  notes: string | null;
  // [null] pour une intervention sans produit (JSON_ARRAYAGG sur LEFT JOIN).
  products: (ApplicationProduct | null)[];
}

export interface RawApplication extends Omit<Application, "products"> {
  products: Application["products"] | string | null;
}

export interface ProductPayload {
  name: string;
  category: string;
  stock: number | string;
  unit: string;
  notes: string;
}

export interface ApplicationPayload {
  date: string;
  notes: string;
  products: { product_id: number; quantity_used: number | null }[];
}

// ─── Prévisions (OpenWeatherMap One Call, `{}` en cas d'erreur) ─

export interface WeatherCondition {
  icon: string;
  description: string;
}

export interface HourlyForecast {
  dt: number;
  temp: number;
  rain?: { "1h"?: number };
}

export interface DailyForecast {
  dt: number;
  sunrise: number;
  sunset: number;
  moonrise: number;
  moonset: number;
  temp: {
    min: number;
    max: number;
    morn: number;
    day: number;
    eve: number;
    night: number;
  };
  feels_like: { morn: number; day: number; eve: number; night: number };
  pressure: number;
  humidity: number;
  dew_point: number;
  wind_speed: number;
  wind_deg: number;
  weather: WeatherCondition[];
  pop: number;
  rain?: number;
  snow?: number;
  uvi: number;
}

export interface ForecastResponse {
  hourly?: HourlyForecast[];
  daily?: DailyForecast[];
}

// ─── Sencrop ─────────────────────────────────────────────────

// Une heure : une entrée par mesure demandée (TEMPERATURE, WIND_SPEED…).
export type SencropHourlyRow = Record<string, { value?: number } | undefined>;

export interface SencropRawRow {
  date: string;
  value: number | null;
}

// fetch_data renvoie `{ success: false }` quand l'appel à Sencrop échoue.
export type SencropRawData = SencropRawRow[] | { success: false };

export type DayWindow = [start: string, end: string];

export interface WeatherSummaryRequest {
  requestId: number;
  rain: DayWindow;
  temperature: DayWindow;
  wind: DayWindow;
}

export interface WeatherSummary {
  requestId?: number;
  rainfallMm?: number | null;
  averageTemperature?: number | null;
  averageWind?: number | null;
}
