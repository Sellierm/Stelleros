import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav";
import { useSocket } from "../contexts/SocketContext";
import usePageMeta from "../hooks/usePageMeta";
import type {
  ConfigResponse,
  GpsPoint,
  LatestPositionsResponse,
  PositionsDatesResponse,
  PositionsHistoryResponse,
} from "../types/api";
import type {
  CoverageResult,
  CoverageTrack,
  CoverageWorkerRequest,
  CoverageWorkerResponse,
  FieldRings,
  LatLngPoint,
} from "../utils/coverageCalculator";
import "./FieldsPage.css";

type LatLngLiteral = google.maps.LatLngLiteral;
type AdvancedMarker = google.maps.marker.AdvancedMarkerElement;
type HistoryByDevice = Record<string, { path: LatLngPoint[]; last: GpsPoint }>;

const CROP_COLORS: Record<string, string> = {
  Blé: "rgb(255, 234, 0)",
  Betteraves: "rgb(165, 39, 20)",
  Colza: "rgb(156, 39, 176)",
  Herbe: "rgb(124, 179, 66)",
  Maïs: "rgb(9, 113, 56)",
  Pdt: "rgb(2, 136, 209)",
  "Seigle/Maïs": "rgb(26, 35, 126)",
  "N/A": "rgb(66, 66, 66)",
};

const YEARS = [2022, 2023, 2024, 2025, 2026, 2027];

// Date du jour (AAAA-MM-JJ) à l'heure de Paris, comme le serveur et gps_days.
// toISOString() donnerait la date UTC, fausse entre minuit et 1 h (2 h en été).
const PARIS_DATE_FORMAT = new Intl.DateTimeFormat("fr-CA", {
  timeZone: "Europe/Paris",
});
const todayParis = () => PARIS_DATE_FORMAT.format(new Date());

// Fréquence de rafraîchissement du panneau latéral en temps réel
const GPS_PANEL_REFRESH_MS = 1000;

const normalizeCultureName = (str: string) => {
  if (!str) return "N/A";
  str = str.toLowerCase();
  // Remove angle brackets if any HTML slipped through
  str = str.replace(/[<>]/g, "");

  if (str.includes("pdt")) return "Pdt";
  if (str.includes("bl")) return "Blé";
  if (str.includes("seigle")) return "Seigle/Maïs";
  if (str.includes("ma")) return "Maïs";
  if (str.includes("bett")) return "Betteraves";
  if (str.includes("colz")) return "Colza";
  if (str.includes("herb") || str.includes("prairie")) return "Herbe";
  return "N/A";
};

const parseKmlCoordinates = (coordinatesNode: Element | undefined) => {
  if (!coordinatesNode) return [];
  return (coordinatesNode.textContent ?? "")
    .trim()
    .split(/\s+/)
    .map((tuple) => {
      const [lng, lat] = tuple.split(",").map(Number);
      return { lat, lng };
    })
    .filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
    );
};

// Pour l'affichage seulement : écarte les points à moins d'environ 1 m du
// précédent (tracteur à l'arrêt, dérive GPS). Le calcul de surface garde tout.
const DISPLAY_MIN_STEP_DEG = 1e-5;
const simplifyDisplayPath = (path: LatLngPoint[]) => {
  const simplified: LatLngLiteral[] = [];
  let previous: LatLngLiteral | null = null;
  for (const { lat, lng } of path) {
    if (
      previous &&
      Math.abs(lat - previous.lat) < DISPLAY_MIN_STEP_DEG &&
      Math.abs(lng - previous.lng) < DISPLAY_MIN_STEP_DEG * 1.5
    ) {
      continue;
    }
    previous = { lat, lng };
    simplified.push(previous);
  }
  const last = path[path.length - 1];
  if (previous && (previous.lat !== last.lat || previous.lng !== last.lng)) {
    simplified.push({ lat: last.lat, lng: last.lng });
  }
  return simplified;
};

const getFieldOverlayStyle = (culture: string, selectedCrop: string | null) => {
  const isSelected = selectedCrop && culture === selectedCrop;
  return {
    fillOpacity: selectedCrop ? (isSelected ? 0.75 : 0.3) : 0.5,
    strokeOpacity: 1,
    strokeWeight: isSelected ? 3 : 1,
    zIndex: isSelected ? 2 : 1,
  };
};

export default function FieldsPage() {
  const socket = useSocket();
  const mapRef = useRef<HTMLDivElement>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const yearRef = useRef(year);
  const [selectedDate, setSelectedDate] = useState("");
  const selectedDateRef = useRef(selectedDate);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  // Synchronise yearRef.current with year
  useEffect(() => {
    yearRef.current = year;
  }, [year]);

  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);

  const [mapsKey, setMapsKey] = useState("");
  const [mapInfo, setMapInfo] = useState(["", ""]);
  const [totalHa, setTotalHa] = useState<string | null>(null);
  const [cropTotals, setCropTotals] = useState<Record<string, number>>({});
  const [selectedCrop, setSelectedCrop] = useState<string | null>(null);
  const [gpsPositions, setGpsPositions] = useState<Record<string, GpsPoint>>(
    {},
  );
  const [showPdtInfo, setShowPdtInfo] = useState(false);
  const [arePanelsVisible, setArePanelsVisible] = useState(true);
  const [implementWidths, setImplementWidths] = useState<
    Record<string, CoverageTrack["widthM"]>
  >({});
  const [availableTrackDevices, setAvailableTrackDevices] = useState<string[]>(
    [],
  );
  const [coverageResult, setCoverageResult] = useState<CoverageResult | null>(
    null,
  );
  const [coverageError, setCoverageError] = useState("");
  const [calculatingCoverage, setCalculatingCoverage] = useState(false);

  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const gpsMarkersRef = useRef<AdvancedMarker[]>([]);
  const markerPositionsRef = useRef<Record<string, LatLngLiteral>>({});
  const gpsPolylinesRef = useRef<google.maps.Polyline[]>([]);
  const gpsSignaturesRef = useRef<Record<string, string>>({});
  const gpsPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const pendingGpsPositionsRef = useRef<Record<string, GpsPoint>>({});
  const activeDeviceIdRef = useRef<string | null>(null);
  const activeInfoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const markerByDeviceRef = useRef<Record<string, AdvancedMarker>>({});
  const infoWindowByDeviceRef = useRef<Record<string, google.maps.InfoWindow>>(
    {},
  );
  const fieldPolygonsRef = useRef<FieldRings[]>([]);
  const fieldOverlaysRef = useRef<
    { overlay: google.maps.Polygon; culture: string }[]
  >([]);
  const trackPointsByDeviceRef = useRef<Record<string, LatLngPoint[]>>({});
  const historyRequestIdRef = useRef(0);
  const coverageWorkerRef = useRef<Worker | null>(null);
  const historyCacheRef = useRef(new Map<string, HistoryByDevice>());

  const selectedCropRef = useRef(selectedCrop);

  useEffect(() => {
    selectedCropRef.current = selectedCrop;
    fieldOverlaysRef.current.forEach(({ overlay, culture }) => {
      overlay.setOptions(getFieldOverlayStyle(culture, selectedCrop));
    });
  }, [selectedCrop]);

  usePageMeta("Fields", "/assets/icons8-champ-32.png");

  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.json() as Promise<ConfigResponse>)
      .then((d) => setMapsKey(d.googleMapsApiKey ?? ""));
  }, []);

  useEffect(() => {
    fetch("/api/positions-dates", { credentials: "include" })
      .then((r) => r.json() as Promise<PositionsDatesResponse>)
      .then((data) => {
        if (!data.success || !Array.isArray(data.dates)) return;
        setAvailableDates(data.dates);
        const today = todayParis();
        const initialDate = data.dates.includes(today)
          ? today
          : data.dates[0] || "";
        setSelectedDate(initialDate);
        selectedDateRef.current = initialDate;
      })
      .catch((err) => console.error("Error loading GPS dates:", err));
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.on("getPlan", (src) => initGoogleMap(src));
    return () => {
      socket.off("getPlan");
    };
  }, [socket, mapsKey]);

  // ── WebSocket : mise à jour temps réel des positions GPS ──────────────────
  useEffect(() => {
    console.log("year:", year, "current:", new Date().getFullYear());
    const isCurrentYear = year === new Date().getFullYear();
    const isToday = selectedDate === todayParis();
    if (!socket) return;

    if (!isCurrentYear || !isToday) return;

    const handleLocationUpdate = (point: GpsPoint) => {
      const map = mapInstanceRef.current;
      if (!map) return;

      const deviceId = String(point.device_id);
      const lat = point.latitude;
      const lng = point.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      // À 10 Hz, les points peuvent arriver dans le désordre : on ignore
      // ceux plus anciens que le dernier affiché pour ce device.
      const ts = Number(point.timestamp);
      const lastTs = Number(gpsSignaturesRef.current[deviceId]?.split("|")[0]);
      if (Number.isFinite(ts) && Number.isFinite(lastTs) && ts < lastTs) return;

      const newPos = { lat, lng };

      // Mettre à jour la signature pour éviter les re-rendus inutiles
      gpsSignaturesRef.current[deviceId] =
        String(point.timestamp) + "|" + lat + "|" + lng;

      markerPositionsRef.current[deviceId] = newPos;

      // Mettre à jour ou créer le marqueur
      if (markerByDeviceRef.current[deviceId]) {
        // Marqueur existant — juste déplacer
        markerByDeviceRef.current[deviceId].position = newPos;

        // Mettre à jour l'infoWindow si ouverte
        if (
          activeDeviceIdRef.current === deviceId &&
          infoWindowByDeviceRef.current[deviceId]
        ) {
          infoWindowByDeviceRef.current[deviceId].setContent(
            buildInfoWindowContent(deviceId, point),
          );
        }
      } else {
        // Nouveau marqueur
        createMarker(map, deviceId, newPos, point);
      }

      // Ajouter le point à la polyligne existante
      appendToPolyline(map, deviceId, newPos);

      // Le panneau latéral est rafraîchi par l'intervalle ci-dessous : à
      // 10 Hz (et en rafale au rattrapage), un rendu par point est inutile.
      pendingGpsPositionsRef.current[deviceId] = point;
    };

    const flushGpsPositions = () => {
      const pending = pendingGpsPositionsRef.current;
      if (Object.keys(pending).length === 0) return;
      pendingGpsPositionsRef.current = {};
      setGpsPositions((prev) => ({ ...prev, ...pending }));
    };

    socket.on("location_update", handleLocationUpdate);
    const flushInterval = setInterval(flushGpsPositions, GPS_PANEL_REFRESH_MS);
    return () => {
      socket.off("location_update", handleLocationUpdate);
      clearInterval(flushInterval);
      pendingGpsPositionsRef.current = {};
    };
  }, [socket, year, selectedDate]); // eslint-disable-line

  useEffect(() => {
    document.body.classList.add("body-overflow-hidden");
    return () => document.body.classList.remove("body-overflow-hidden");
  }, []);

  const changeYear = (y: number) => {
    setYear(y);
    yearRef.current = y; // Update synchronously!
    if (socket) socket.emit("askPlan", y);
    const yearDates = availableDates.filter((date) => date.startsWith(`${y}-`));
    const nextDate = yearDates.includes(selectedDateRef.current)
      ? selectedDateRef.current
      : yearDates[0] || "";
    changeDate(nextDate);
  };

  const changeDate = (date: string) => {
    setSelectedDate(date);
    selectedDateRef.current = date;
    cancelCoverage();
    setCoverageResult(null);
    setCoverageError("");
  };

  // Seul point de chargement de l'historique lors d'un changement de date.
  useEffect(() => {
    if (!selectedDate || !mapInstanceRef.current) return;
    void loadPositionHistory(mapInstanceRef.current, selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    if (socket && mapsKey) socket.emit("askPlan", year);
  }, [socket, mapsKey]); // eslint-disable-line

  const getTrailColor = (deviceId: string) => {
    const palette = [
      "#ff6b00",
      "#1976d2",
      "#2e7d32",
      "#8e24aa",
      "#d81b60",
      "#00838f",
    ];
    const str = String(deviceId || "0");
    const hash = str.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return palette[hash % palette.length];
  };

  // ── Polyligne : map par device pour pouvoir étendre en temps réel ─────────
  const polylinesMapRef = useRef<Record<string, google.maps.Polyline>>({});

  const appendToPolyline = (
    map: google.maps.Map,
    deviceId: string,
    newPos: LatLngLiteral,
  ) => {
    if (!polylinesMapRef.current[deviceId]) {
      const polyline = new google.maps.Polyline({
        path: [newPos],
        geodesic: false,
        strokeColor: getTrailColor(deviceId),
        strokeOpacity: 0.85,
        strokeWeight: 3,
        map,
      });
      polylinesMapRef.current[deviceId] = polyline;
      gpsPolylinesRef.current.push(polyline);
    } else {
      const path = polylinesMapRef.current[deviceId].getPath();
      path.push(new google.maps.LatLng(newPos.lat, newPos.lng));
    }
  };

  const fetchPositionHistory = async (
    date: string,
  ): Promise<HistoryByDevice | null> => {
    const cached = historyCacheRef.current.get(date);
    if (cached) return cached;

    const res = await fetch(
      `/api/positions-history?date=${encodeURIComponent(date)}`,
      { credentials: "include" },
    );
    const data = (await res.json()) as PositionsHistoryResponse;
    if (!data.success) return null;

    const historyByDevice: HistoryByDevice = {};
    for (const [deviceId, { track = [], last }] of Object.entries(
      data.positions || {},
    )) {
      const path = track
        .map(([lat, lng, t]) => ({ lat, lng, t }))
        .filter(
          (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
        );
      if (path.length > 0) historyByDevice[deviceId] = { path, last };
    }

    // Les journées passées ne changent plus : on les garde en mémoire.
    if (date < todayParis()) {
      historyCacheRef.current.set(date, historyByDevice);
    }
    return historyByDevice;
  };

  // Réutilise le marqueur existant du tracteur plutôt que de le recréer.
  const placeMarker = (
    map: google.maps.Map,
    deviceId: string,
    position: LatLngLiteral,
    point: GpsPoint,
  ) => {
    const marker = markerByDeviceRef.current[deviceId];
    if (!marker) {
      createMarker(map, deviceId, position, point);
      return;
    }
    marker.position = position;
    marker.map = map;
    infoWindowByDeviceRef.current[deviceId]?.setContent(
      buildInfoWindowContent(deviceId, point),
    );
  };

  const removeMarkersExcept = (deviceIds: Set<string>) => {
    for (const [deviceId, marker] of Object.entries(
      markerByDeviceRef.current,
    )) {
      if (deviceIds.has(deviceId)) continue;
      marker.map = null;
      infoWindowByDeviceRef.current[deviceId]?.close();
      delete markerByDeviceRef.current[deviceId];
      delete infoWindowByDeviceRef.current[deviceId];
    }
    gpsMarkersRef.current = gpsMarkersRef.current.filter((marker) =>
      Object.values(markerByDeviceRef.current).includes(marker),
    );
  };

  const loadPositionHistory = async (
    map: google.maps.Map,
    date = selectedDateRef.current,
  ) => {
    if (!map || !date) return;

    const requestId = ++historyRequestIdRef.current;

    try {
      const historyByDevice = await fetchPositionHistory(date);
      if (requestId !== historyRequestIdRef.current) return;
      if (!historyByDevice || !map) return;

      // Vider les polylignes existantes
      gpsPolylinesRef.current.forEach((line) => line.setMap(null));
      gpsPolylinesRef.current = [];
      polylinesMapRef.current = {};

      trackPointsByDeviceRef.current = {};
      removeMarkersExcept(new Set(Object.keys(historyByDevice)));

      const historicalPositions: Record<string, GpsPoint> = {};
      for (const [deviceId, { path, last }] of Object.entries(
        historyByDevice,
      )) {
        trackPointsByDeviceRef.current[deviceId] = path;

        const lastPosition = {
          lat: path[path.length - 1].lat,
          lng: path[path.length - 1].lng,
        };
        historicalPositions[deviceId] = last;
        markerPositionsRef.current[deviceId] = lastPosition;
        placeMarker(map, deviceId, lastPosition, last);

        const polyline = new google.maps.Polyline({
          path: simplifyDisplayPath(path),
          geodesic: false,
          strokeColor: getTrailColor(deviceId),
          strokeOpacity: 0.85,
          strokeWeight: 3,
          map,
        });

        polylinesMapRef.current[deviceId] = polyline;
        gpsPolylinesRef.current.push(polyline);
      }
      setAvailableTrackDevices(Object.keys(trackPointsByDeviceRef.current));
      setGpsPositions((previous) => ({ ...previous, ...historicalPositions }));
    } catch (err) {
      if (requestId === historyRequestIdRef.current) {
        console.error("Error loading GPS history:", err);
      }
    }
  };

  const buildInfoWindowContent = (deviceId: string, pos: GpsPoint) => {
    const speedKmh = pos.speed != null ? (pos.speed * 3.6).toFixed(1) : null;
    const headingStr =
      pos.heading != null ? `${Number(pos.heading).toFixed(0)}°` : null;
    const sourceStr = pos.source || "unknown";
    const accuracyStr =
      pos.accuracy != null ? `${Number(pos.accuracy).toFixed(2)}m` : null;

    return `
      <div class="tractor-info-window">
        <strong>Device ID:</strong> ${deviceId}<br/>
        <strong>Position:</strong> ${pos.latitude.toFixed(6)}, ${pos.longitude.toFixed(6)}<br/>
        ${pos.altitude != null ? `<strong>Altitude:</strong> ${Number(pos.altitude).toFixed(1)}m<br/>` : ""}
        ${accuracyStr ? `<strong>Précision:</strong> ${accuracyStr}<br/>` : ""}
        ${speedKmh ? `<strong>Vitesse:</strong> ${speedKmh} km/h<br/>` : ""}
        ${headingStr ? `<strong>Cap:</strong> ${headingStr}<br/>` : ""}
        <strong>Source:</strong> ${sourceStr}<br/>
        <strong>Mise à jour:</strong> ${new Date(pos.timestamp).toLocaleString("fr-FR")}
      </div>`;
  };

  const createMarker = (
    map: google.maps.Map,
    deviceId: string,
    position: LatLngLiteral,
    pos: GpsPoint,
  ) => {
    const tractorIcon = document.createElement("img");
    if (deviceId === "7724") tractorIcon.src = "/assets/tracteur_red.png";
    else if (deviceId === "6290") tractorIcon.src = "/assets/tracteur.png";
    else tractorIcon.src = "/assets/tracteur.png";
    tractorIcon.style.width = "40px";
    tractorIcon.style.height = "40px";
    tractorIcon.style.cursor = "pointer";

    const marker = new google.maps.marker.AdvancedMarkerElement({
      position,
      map,
      title: `Device: ${deviceId}`,
      content: tractorIcon,
    });

    const infoWindow = new google.maps.InfoWindow({
      content: buildInfoWindowContent(deviceId, pos),
    });

    marker.addListener("click", () => {
      if (activeInfoWindowRef.current) activeInfoWindowRef.current.close();
      infoWindow.open({ anchor: marker, map: marker.map });
      activeInfoWindowRef.current = infoWindow;
      activeDeviceIdRef.current = deviceId;
    });

    gpsMarkersRef.current.push(marker);
    markerByDeviceRef.current[deviceId] = marker;
    infoWindowByDeviceRef.current[deviceId] = infoWindow;
  };

  const loadGPSPositions = async (
    map: google.maps.Map,
    forceRefresh = false,
  ) => {
    try {
      if (yearRef.current !== new Date().getFullYear()) return false;

      const res = await fetch("/api/latest-positions", {
        credentials: "include",
      });
      const data = (await res.json()) as LatestPositionsResponse;

      // Double check in case year changed during fetch
      if (yearRef.current !== new Date().getFullYear()) return false;

      if (!data.success || !map) return false;

      const positions = data.positions || {};
      const nextSignatures: Record<string, string> = {};
      for (const deviceId in positions) {
        const pos = positions[deviceId];
        nextSignatures[deviceId] =
          String(pos.timestamp || "") +
          "|" +
          String(pos.latitude || "") +
          "|" +
          String(pos.longitude || "");
      }

      const prevKeys = Object.keys(gpsSignaturesRef.current);
      const nextKeys = Object.keys(nextSignatures);
      const hasChanges =
        prevKeys.length !== nextKeys.length ||
        nextKeys.some(
          (deviceId) =>
            gpsSignaturesRef.current[deviceId] !== nextSignatures[deviceId],
        );

      if (!hasChanges && !forceRefresh) return false;

      gpsSignaturesRef.current = nextSignatures;

      // Vider les anciens marqueurs
      activeInfoWindowRef.current?.close();
      gpsMarkersRef.current.forEach((m) => {
        m.map = null;
      });
      gpsMarkersRef.current = [];
      markerByDeviceRef.current = {};
      infoWindowByDeviceRef.current = {};

      const newGps: Record<string, GpsPoint> = {};
      for (const deviceId in positions) {
        const pos = positions[deviceId];
        const position = { lat: pos.latitude, lng: pos.longitude };
        markerPositionsRef.current[deviceId] = position;
        newGps[deviceId] = pos;
        createMarker(map, deviceId, position, pos);
      }

      // Restaurer l'infoWindow active si elle était ouverte
      const activeId = activeDeviceIdRef.current;
      if (
        activeId &&
        markerByDeviceRef.current[activeId] &&
        infoWindowByDeviceRef.current[activeId]
      ) {
        infoWindowByDeviceRef.current[activeId].open(
          map,
          markerByDeviceRef.current[activeId],
        );
        activeInfoWindowRef.current = infoWindowByDeviceRef.current[activeId];
      } else if (activeInfoWindowRef.current) {
        activeInfoWindowRef.current.close();
        activeInfoWindowRef.current = null;
        activeDeviceIdRef.current = null;
      }

      setGpsPositions(newGps);
      return true;
    } catch (err) {
      console.error("Error loading GPS positions:", err);
      return false;
    }
  };

  const initGoogleMap = (src: string | null) => {
    if (!mapsKey) return;

    const loadMap = () => {
      if (!mapRef.current) return;

      const map = new google.maps.Map(mapRef.current, {
        center: new google.maps.LatLng(50.39977, 3.040901),
        zoom: 14,
        mapTypeId: "satellite",
        streetViewControl: false,
        mapId: "FARM_GPS_MAP",
        tilt: 0,
      });
      mapInstanceRef.current = map;

      const loadKml = async () => {
        try {
          if (!src) throw new Error("No KML plan for this year");

          const response = await fetch(src);
          if (!response.ok) {
            throw new Error(`KML request failed with HTTP ${response.status}`);
          }

          const kmlText = await response.text();
          const kmlDoc = new DOMParser().parseFromString(kmlText, "text/xml");
          if (kmlDoc.querySelector("parsererror")) {
            throw new Error("Invalid KML document");
          }

          const placemarks = kmlDoc.getElementsByTagName("Placemark");

          let total = 0;
          const cTotals: Record<string, number> = {};
          const fieldPolygons: FieldRings[] = [];
          fieldOverlaysRef.current.forEach(({ overlay }) =>
            overlay.setMap(null),
          );
          fieldOverlaysRef.current = [];

          for (let i = 0; i < placemarks.length; i++) {
            let surface = 0;
            let cultureStr = "";

            const desc: Element | undefined =
              placemarks[i].getElementsByTagName("description")[0];
            if (desc) {
              const m = desc.textContent?.match(
                /Surface\s*\(Ha\)\s*:\s*([\d.,]+)/i,
              );
              if (m) {
                surface = Number.parseFloat(m[1].replace(",", "."));
              }
            }

            const extendedData = placemarks[i].getElementsByTagName("Data");
            for (let j = 0; j < extendedData.length; j++) {
              if (extendedData[j].getAttribute("name") === "Culture") {
                const valueTag =
                  extendedData[j].getElementsByTagName("value")[0];
                if (valueTag) cultureStr = valueTag.textContent ?? "";
              }
            }

            if (!cultureStr && desc) {
              const plainDesc = (desc.textContent ?? "").replace(
                /<[^>]+>/g,
                "\n",
              );
              const mC = plainDesc.match(/Culture\s*:\s*([^\n]+)/i);
              if (mC) cultureStr = mC[1].trim();
            }

            const cultureName = normalizeCultureName(cultureStr);
            const polygonNodes = placemarks[i].getElementsByTagName("Polygon");
            for (let p = 0; p < polygonNodes.length; p++) {
              const outerBoundary =
                polygonNodes[p].getElementsByTagName("outerBoundaryIs")[0];
              const coordinatesNode = (
                outerBoundary || polygonNodes[p]
              ).getElementsByTagName("coordinates")[0];
              if (!coordinatesNode) continue;

              const points = parseKmlCoordinates(coordinatesNode);
              const holes = Array.from(
                polygonNodes[p].getElementsByTagName("innerBoundaryIs"),
              )
                .map((inner) =>
                  parseKmlCoordinates(
                    inner.getElementsByTagName("coordinates")[0],
                  ),
                )
                .filter((hole) => hole.length >= 3);
              if (points.length >= 3) {
                fieldPolygons.push({ outer: points, holes });
                const overlay = new google.maps.Polygon({
                  paths: [points, ...holes],
                  map,
                  strokeColor: CROP_COLORS[cultureName] || "#ffffff",
                  fillColor: CROP_COLORS[cultureName] || "#ffffff",
                  clickable: true,
                  ...getFieldOverlayStyle(cultureName, selectedCropRef.current),
                });
                overlay.addListener("click", () => {
                  const content = desc?.textContent || "";
                  const lines = content
                    .replace(/<[^>]+>/g, "\n")
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean);
                  const infos = lines
                    .filter((line) => line.includes(":"))
                    .slice(0, 2)
                    .map((line) => {
                      const index = line.indexOf(":");
                      return `${line.slice(0, index)} ${line.slice(index)}`;
                    });
                  setMapInfo([infos[0] || "", infos[1] || ""]);
                  if (cultureName !== "N/A") setSelectedCrop(cultureName);
                });
                fieldOverlaysRef.current.push({
                  overlay,
                  culture: cultureName,
                });
              }
            }

            cTotals[cultureName] = (cTotals[cultureName] || 0) + surface;
            total += surface;
          }
          setTotalHa(total.toFixed(2));
          setCropTotals(cTotals);
          fieldPolygonsRef.current = fieldPolygons;
          if (fieldPolygons.length > 0) {
            const bounds = new google.maps.LatLngBounds();
            fieldPolygons.forEach(({ outer }) =>
              outer.forEach((point) => bounds.extend(point)),
            );
            map.fitBounds(bounds);
          }
        } catch (error) {
          console.error("Error loading KML layer:", error);
        }
      };

      void loadKml();

      // ── Chargement initial conditionné à l'année courante ──────────────
      const isCurrentYear = yearRef.current === new Date().getFullYear();
      if (isCurrentYear) {
        loadGPSPositions(map, true).then(() => {
          if (selectedDateRef.current) {
            loadPositionHistory(map, selectedDateRef.current);
          }
        });
      } else if (selectedDateRef.current) {
        loadPositionHistory(map, selectedDateRef.current);
      }

      // Polling de fallback toutes les 30s
      if (gpsPollIntervalRef.current) clearInterval(gpsPollIntervalRef.current);
      gpsPollIntervalRef.current = setInterval(async () => {
        // Ne rien faire si l'année sélectionnée n'est pas l'année courante
        if (
          yearRef.current !== new Date().getFullYear() ||
          selectedDateRef.current !== todayParis()
        )
          return;
        const changed = await loadGPSPositions(map);
        if (changed) loadPositionHistory(map);
      }, 30000);
    };

    if (window.google && window.google.maps) {
      loadMap();
    } else {
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${mapsKey}&libraries=marker&callback=__farmMapsLoaded`;
      script.async = true;
      window.__farmMapsLoaded = () => loadMap();
      document.head.appendChild(script);
    }
  };

  useEffect(() => {
    return () => {
      if (gpsPollIntervalRef.current) clearInterval(gpsPollIntervalRef.current);
      gpsPolylinesRef.current.forEach((line) => line.setMap(null));
    };
  }, []);

  const centerOnDevice = (deviceId: string) => {
    if (mapInstanceRef.current && markerPositionsRef.current[deviceId]) {
      mapInstanceRef.current.setCenter(markerPositionsRef.current[deviceId]);
      const marker = markerByDeviceRef.current[deviceId];
      const infoWindow = infoWindowByDeviceRef.current[deviceId];
      if (marker && infoWindow) {
        if (activeInfoWindowRef.current) activeInfoWindowRef.current.close();
        infoWindow.open(mapInstanceRef.current, marker);
        activeInfoWindowRef.current = infoWindow;
        activeDeviceIdRef.current = deviceId;
      }
    }
  };

  const formatSpeed = (pos: GpsPoint) => {
    if (pos.speed == null) return null;
    return `${(pos.speed * 3.6).toFixed(1)} km/h`;
  };

  const getImplementWidth = (deviceId: string) =>
    implementWidths[deviceId] ?? 3;

  const setDeviceWidth = (deviceId: string, value: string) => {
    setImplementWidths((previous) => ({ ...previous, [deviceId]: value }));
  };

  const cancelCoverage = () => {
    if (!coverageWorkerRef.current) return;
    coverageWorkerRef.current.terminate();
    coverageWorkerRef.current = null;
    setCalculatingCoverage(false);
  };

  useEffect(() => cancelCoverage, []); // eslint-disable-line

  const calculateCoverage = () => {
    setCoverageError("");
    setCoverageResult(null);

    if (!fieldPolygonsRef.current.length) {
      setCoverageError("Aucun contour de champ chargé pour cette année");
      return;
    }
    if (!availableTrackDevices.length) {
      setCoverageError("Aucune trace GPS disponible pour cette date");
      return;
    }

    const tracksWithWidth = availableTrackDevices.map(
      (deviceId): CoverageTrack => ({
        deviceId,
        points: trackPointsByDeviceRef.current[deviceId],
        widthM: getImplementWidth(deviceId),
      }),
    );

    cancelCoverage();
    setCalculatingCoverage(true);
    const worker = new Worker(
      new URL("../utils/coverageWorker.ts", import.meta.url),
      { type: "module" },
    );
    coverageWorkerRef.current = worker;
    const finish = () => {
      worker.terminate();
      if (coverageWorkerRef.current === worker) {
        coverageWorkerRef.current = null;
      }
      setCalculatingCoverage(false);
    };
    worker.onmessage = ({ data }: MessageEvent<CoverageWorkerResponse>) => {
      if ("error" in data) setCoverageError(data.error);
      else setCoverageResult(data.result);
      finish();
    };
    worker.onerror = (event) => {
      setCoverageError(event.message || "Erreur de calcul");
      finish();
    };
    worker.postMessage({
      fieldPolygons: fieldPolygonsRef.current,
      tracks: tracksWithWidth,
    } satisfies CoverageWorkerRequest);
  };

  return (
    <div className="fields-page">
      <Nav />
      <div id="mapCap">
        <div
          className={`fields-layout ${arePanelsVisible ? "" : "panels-hidden"}`}
        >
          <div
            id="legend"
            className={arePanelsVisible ? "" : "fields-panel-hidden"}
          >
            <h2>Légende</h2>
            {Object.entries(CROP_COLORS).map(([name, color]) => (
              <div
                className={`lin ${selectedCrop === name ? "selected" : ""}`}
                key={name}
                id={name === "Pdt" ? "pdt" : undefined}
                onMouseEnter={
                  name === "Pdt" ? () => setShowPdtInfo(true) : undefined
                }
                onMouseLeave={
                  name === "Pdt" ? () => setShowPdtInfo(false) : undefined
                }
                onClick={() =>
                  setSelectedCrop((prev) => (prev === name ? null : name))
                }
                style={{
                  cursor: "pointer",
                  fontWeight: selectedCrop === name ? "bold" : "normal",
                  opacity: selectedCrop && selectedCrop !== name ? 0.5 : 1,
                }}
              >
                <div
                  style={{
                    backgroundColor: color,
                    boxSizing: "border-box",
                    border: selectedCrop === name ? "2px solid white" : "none",
                  }}
                />
                <p>{name === "Pdt" ? "Pdt*" : name}</p>
              </div>
            ))}
            {showPdtInfo && (
              <div className="lin">
                <p id="info" style={{ padding: 0, marginTop: "-2%" }}>
                  *Pdt: Pomme de terre
                </p>
              </div>
            )}
          </div>

          <div className="fields-map-column">
            <div id="map" ref={mapRef} />
            <div className="fields-filters">
              <select
                id="year"
                value={year}
                onChange={(e) => changeYear(parseInt(e.target.value))}
              >
                {YEARS.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <select
                id="gps-date"
                value={selectedDate}
                onChange={(e) => changeDate(e.target.value)}
                disabled={
                  !availableDates.filter((date) => date.startsWith(`${year}-`))
                    .length
                }
              >
                {!availableDates.filter((date) => date.startsWith(`${year}-`))
                  .length && <option value="">Aucune trace</option>}
                {availableDates
                  .filter((date) => date.startsWith(`${year}-`))
                  .map((date) => (
                    <option key={date} value={date}>
                      {date}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <button
            className="fields-layout-toggle"
            type="button"
            aria-label={
              arePanelsVisible
                ? "Masquer les panneaux"
                : "Afficher les panneaux"
            }
            aria-expanded={arePanelsVisible}
            onClick={() => setArePanelsVisible((visible) => !visible)}
          >
            {arePanelsVisible
              ? "⟨ Masquer les panneaux ⟩"
              : "⟨ Afficher les panneaux ⟩"}
          </button>

          <div
            id="infoPanel"
            className={arePanelsVisible ? "" : "fields-panel-hidden"}
          >
            <div id="capture">
              <h2>Info</h2>
              <div className="lin">
                <p>{mapInfo[0]}</p>
              </div>
              <div className="lin">
                <p>{mapInfo[1]}</p>
              </div>
            </div>
            <div id="newCapture">
              <h2>Données</h2>
              <div className="lin">
                <p>Total (Ha) : {totalHa !== null ? totalHa : ""}</p>
              </div>
              {selectedCrop && (
                <div className="lin">
                  <p>
                    {selectedCrop} (Ha) :{" "}
                    {cropTotals[selectedCrop]
                      ? cropTotals[selectedCrop].toFixed(2)
                      : "0.00"}
                  </p>
                </div>
              )}
            </div>
            <div id="coverageCalc">
              <h2>Surface couverte</h2>
              {availableTrackDevices.length === 0 ? (
                <div className="lin">
                  <p className="coverage-muted">Aucune trace pour cette date</p>
                </div>
              ) : (
                availableTrackDevices.map((deviceId) => (
                  <div className="lin coverage-device-row" key={deviceId}>
                    <label htmlFor={`width-${deviceId}`}>
                      Largeur {deviceId} (m)
                    </label>
                    <input
                      id={`width-${deviceId}`}
                      type="number"
                      min="0.1"
                      max="30"
                      step="0.1"
                      value={getImplementWidth(deviceId)}
                      onChange={(event) =>
                        setDeviceWidth(deviceId, event.target.value)
                      }
                    />
                  </div>
                ))
              )}
              <div className="lin">
                <button
                  className="pp-btn pp-btn-primary"
                  onClick={calculateCoverage}
                  disabled={
                    calculatingCoverage || availableTrackDevices.length === 0
                  }
                >
                  {calculatingCoverage ? "Calcul..." : "Calculer"}
                </button>
              </div>
              {coverageError && (
                <div className="lin">
                  <p className="coverage-error">{coverageError}</p>
                </div>
              )}
              {coverageResult && coverageResult.warnings.length > 0 && (
                <div className="lin">
                  <p className="coverage-warning">
                    {coverageResult.warnings.join(" · ")}
                  </p>
                </div>
              )}
              {coverageResult && (
                <div className="lin">
                  <p>{coverageResult.totalAreaHa.toFixed(2)} Ha couverts</p>
                </div>
              )}
            </div>
            <div id="gpsDevices">
              <h2>GPS</h2>
              <div id="deviceButtons">
                {Object.keys(gpsPositions).map((id) => {
                  const pos = gpsPositions[id];
                  const speed = formatSpeed(pos);
                  return (
                    <button
                      key={id}
                      className="device-btn"
                      onClick={() => centerOnDevice(id)}
                      title={speed ? `Vitesse: ${speed}` : ""}
                    >
                      📍 {id}
                      {speed && (
                        <span
                          style={{
                            display: "block",
                            fontSize: "0.75em",
                            opacity: 0.8,
                          }}
                        >
                          {speed}
                        </span>
                      )}
                      {pos.source && (
                        <span
                          style={{
                            display: "block",
                            fontSize: "0.7em",
                            opacity: 0.65,
                          }}
                        >
                          {pos.source}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
