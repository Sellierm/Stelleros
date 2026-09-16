import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav.jsx";
import { useSocket } from "../contexts/SocketContext.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import { computeCoverageArea } from "../utils/coverageCalculator.js";
import "./FieldsPage.css";

const CROP_COLORS = {
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

const normalizeCultureName = (str) => {
  if (!str) return "N/A";
  str = str.toLowerCase();
  // Strip HTML tags if any slipped through
  str = str.replace(/<[^>]+>/g, "");

  if (str.includes("pdt")) return "Pdt";
  if (str.includes("bl")) return "Blé";
  if (str.includes("seigle")) return "Seigle/Maïs";
  if (str.includes("ma")) return "Maïs";
  if (str.includes("bett")) return "Betteraves";
  if (str.includes("colz")) return "Colza";
  if (str.includes("herb") || str.includes("prairie")) return "Herbe";
  return "N/A";
};

export default function FieldsPage() {
  const socket = useSocket();
  const mapRef = useRef(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const yearRef = useRef(year);
  const [selectedDate, setSelectedDate] = useState("");
  const selectedDateRef = useRef(selectedDate);
  const [availableDates, setAvailableDates] = useState([]);

  // Synchronise yearRef.current with year
  useEffect(() => {
    yearRef.current = year;
  }, [year]);

  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);

  const [mapsKey, setMapsKey] = useState("");
  const [mapInfo, setMapInfo] = useState(["", ""]);
  const [totalHa, setTotalHa] = useState(null);
  const [cropTotals, setCropTotals] = useState({});
  const [selectedCrop, setSelectedCrop] = useState(null);
  const [gpsPositions, setGpsPositions] = useState({});
  const [showPdtInfo, setShowPdtInfo] = useState(false);
  const [implementWidths, setImplementWidths] = useState({});
  const [availableTrackDevices, setAvailableTrackDevices] = useState([]);
  const [coverageResult, setCoverageResult] = useState(null);
  const [coverageError, setCoverageError] = useState("");
  const [calculatingCoverage, setCalculatingCoverage] = useState(false);

  const mapInstanceRef = useRef(null);
  const gpsMarkersRef = useRef([]);
  const markerPositionsRef = useRef({});
  const gpsPolylinesRef = useRef([]);
  const gpsSignaturesRef = useRef({});
  const gpsPollIntervalRef = useRef(null);
  const activeDeviceIdRef = useRef(null);
  const activeInfoWindowRef = useRef(null);
  const markerByDeviceRef = useRef({});
  const infoWindowByDeviceRef = useRef({});
  const fieldPolygonsRef = useRef([]);
  const trackPointsByDeviceRef = useRef({});

  usePageMeta("Fields", "/assets/icons8-champ-32.png");

  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setMapsKey(d.googleMapsApiKey));
  }, []);

  useEffect(() => {
    fetch("/api/positions-dates", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (!data.success || !Array.isArray(data.dates)) return;
        setAvailableDates(data.dates);
        const today = new Date().toISOString().slice(0, 10);
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
    return () => socket.off("getPlan");
  }, [socket, mapsKey]);

  // ── WebSocket : mise à jour temps réel des positions GPS ──────────────────
  useEffect(() => {
    console.log("year:", year, "current:", new Date().getFullYear());
    const isCurrentYear = year === new Date().getFullYear();
    const isToday = selectedDate === new Date().toISOString().slice(0, 10);
    if (!socket) return;

    if (!isCurrentYear || !isToday) return;

    const handleLocationUpdate = (point) => {
      const map = mapInstanceRef.current;
      if (!map) return;

      const deviceId = String(point.device_id);
      const lat = parseFloat(point.latitude);
      const lng = parseFloat(point.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

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

      // Mettre à jour le state React pour le panneau latéral
      setGpsPositions((prev) => ({ ...prev, [deviceId]: point }));
    };

    socket.on("location_update", handleLocationUpdate);
    return () => socket.off("location_update", handleLocationUpdate);
  }, [socket, year, selectedDate]); // eslint-disable-line

  useEffect(() => {
    document.body.classList.add("body-overflow-hidden");
    return () => document.body.classList.remove("body-overflow-hidden");
  }, []);

  const changeYear = (y) => {
    setYear(y);
    yearRef.current = y; // Update synchronously!
    if (socket) socket.emit("askPlan", y);
    const yearDates = availableDates.filter((date) => date.startsWith(`${y}-`));
    const nextDate = yearDates.includes(selectedDateRef.current)
      ? selectedDateRef.current
      : yearDates[0] || "";
    changeDate(nextDate);
  };

  const changeDate = (date) => {
    setSelectedDate(date);
    selectedDateRef.current = date;
    setCoverageResult(null);
    setCoverageError("");
    if (mapInstanceRef.current)
      loadPositionHistory(mapInstanceRef.current, date);
  };

  useEffect(() => {
    if (socket && mapsKey) socket.emit("askPlan", year);
  }, [socket, mapsKey]); // eslint-disable-line

  const getTrailColor = (deviceId) => {
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
  const polylinesMapRef = useRef({});

  const appendToPolyline = (map, deviceId, newPos) => {
    if (!polylinesMapRef.current[deviceId]) {
      const polyline = new window.google.maps.Polyline({
        path: [newPos],
        geodesic: true,
        strokeColor: getTrailColor(deviceId),
        strokeOpacity: 0.85,
        strokeWeight: 3,
        map,
      });
      polylinesMapRef.current[deviceId] = polyline;
      gpsPolylinesRef.current.push(polyline);
    } else {
      const path = polylinesMapRef.current[deviceId].getPath();
      path.push(new window.google.maps.LatLng(newPos.lat, newPos.lng));
    }
  };

  const loadPositionHistory = async (map, date = selectedDateRef.current) => {
    try {
      const res = await fetch(
        `/api/positions-history?date=${encodeURIComponent(date)}`,
        { credentials: "include" },
      );
      const data = await res.json();
      if (!data.success || !map) return;

      // Vider les polylignes existantes
      gpsPolylinesRef.current.forEach((line) => line.setMap(null));
      gpsPolylinesRef.current = [];
      polylinesMapRef.current = {};

      const historyByDevice = data.positions || {};
      trackPointsByDeviceRef.current = {};

      gpsMarkersRef.current.forEach((marker) => marker.setMap(null));
      gpsMarkersRef.current = [];
      markerByDeviceRef.current = {};
      infoWindowByDeviceRef.current = {};

      const historicalPositions = {};
      for (const deviceId of Object.keys(historyByDevice)) {
        const rawSeries = Array.isArray(historyByDevice[deviceId])
          ? historyByDevice[deviceId]
          : [];

        const path = rawSeries
          .map((point) => ({
            lat: Number(point.latitude),
            lng: Number(point.longitude),
          }))
          .filter(
            (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
          );

        if (path.length < 1) continue;
        trackPointsByDeviceRef.current[deviceId] = path;

        const lastPoint = rawSeries[rawSeries.length - 1];
        const lastPosition = {
          lat: Number(lastPoint.latitude),
          lng: Number(lastPoint.longitude),
        };
        if (
          Number.isFinite(lastPosition.lat) &&
          Number.isFinite(lastPosition.lng)
        ) {
          historicalPositions[deviceId] = lastPoint;
          markerPositionsRef.current[deviceId] = lastPosition;
          createMarker(map, deviceId, lastPosition, lastPoint);
        }

        const polyline = new window.google.maps.Polyline({
          path,
          geodesic: true,
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
      console.error("Error loading GPS history:", err);
    }
  };

  const buildInfoWindowContent = (deviceId, pos) => {
    const speedKmh = pos.speed != null ? (pos.speed * 3.6).toFixed(1) : null;
    const headingStr =
      pos.heading != null ? `${Number(pos.heading).toFixed(0)}°` : null;
    const sourceStr = pos.source || "unknown";
    const accuracyStr =
      pos.accuracy != null ? `${Number(pos.accuracy).toFixed(2)}m` : null;

    return `
      <div style="padding:5px;min-width:200px">
        <strong>Device ID:</strong> ${deviceId}<br/>
        <strong>Position:</strong> ${parseFloat(pos.latitude).toFixed(6)}, ${parseFloat(pos.longitude).toFixed(6)}<br/>
        ${pos.altitude != null ? `<strong>Altitude:</strong> ${Number(pos.altitude).toFixed(1)}m<br/>` : ""}
        ${accuracyStr ? `<strong>Précision:</strong> ${accuracyStr}<br/>` : ""}
        ${speedKmh ? `<strong>Vitesse:</strong> ${speedKmh} km/h<br/>` : ""}
        ${headingStr ? `<strong>Cap:</strong> ${headingStr}<br/>` : ""}
        <strong>Source:</strong> ${sourceStr}<br/>
        <strong>Mise à jour:</strong> ${new Date(pos.timestamp).toLocaleString("fr-FR")}
      </div>`;
  };

  const createMarker = (map, deviceId, position, pos) => {
    const tractorIcon = document.createElement("img");
    if (deviceId === "7724") tractorIcon.src = "/assets/tracteur_red.png";
    else if (deviceId === "6290") tractorIcon.src = "/assets/tracteur.png";
    else tractorIcon.src = "/assets/tracteur.png";
    tractorIcon.style.width = "40px";
    tractorIcon.style.height = "40px";
    tractorIcon.style.cursor = "pointer";

    const marker = new window.google.maps.marker.AdvancedMarkerElement({
      position,
      map,
      title: `Device: ${deviceId}`,
      content: tractorIcon,
    });

    const infoWindow = new window.google.maps.InfoWindow({
      content: buildInfoWindowContent(deviceId, pos),
    });

    marker.addListener("click", () => {
      if (activeInfoWindowRef.current) activeInfoWindowRef.current.close();
      infoWindow.open(map, marker);
      activeInfoWindowRef.current = infoWindow;
      activeDeviceIdRef.current = deviceId;
    });

    gpsMarkersRef.current.push(marker);
    markerByDeviceRef.current[deviceId] = marker;
    infoWindowByDeviceRef.current[deviceId] = infoWindow;
  };

  const loadGPSPositions = async (map, forceRefresh = false) => {
    try {
      if (yearRef.current !== new Date().getFullYear()) return false;

      const res = await fetch("/api/latest-positions", {
        credentials: "include",
      });
      const data = await res.json();

      // Double check in case year changed during fetch
      if (yearRef.current !== new Date().getFullYear()) return false;

      if (!data.success || !map) return false;

      const positions = data.positions || {};
      const nextSignatures = {};
      for (const deviceId in positions) {
        const pos = positions[deviceId] || {};
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
      gpsMarkersRef.current.forEach((m) => m.setMap(null));
      gpsMarkersRef.current = [];
      markerByDeviceRef.current = {};
      infoWindowByDeviceRef.current = {};

      const newGps = {};
      for (const deviceId in positions) {
        const pos = positions[deviceId];
        const position = {
          lat: parseFloat(pos.latitude),
          lng: parseFloat(pos.longitude),
        };
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

  const initGoogleMap = (src) => {
    if (!mapsKey) return;

    const loadMap = () => {
      const map = new window.google.maps.Map(mapRef.current, {
        center: new window.google.maps.LatLng(50.39977, 3.040901),
        zoom: 14,
        mapTypeId: "satellite",
        streetViewControl: false,
        mapId: "FARM_GPS_MAP",
        tilt: 0,
      });
      mapInstanceRef.current = map;

      const kmlLayer = new window.google.maps.KmlLayer(src, {
        suppressInfoWindows: true,
        preserveViewport: true,
        map,
      });

      kmlLayer.addListener("click", (event) => {
        const content = event.featureData.description || "";
        const dataTab = [];
        let j = 0;
        dataTab[0] = "";
        for (let i = 0; i < content.length; i++) {
          if (content[i] === "<") {
            j += 1;
            i += 3;
            dataTab[j] = "";
          } else {
            dataTab[j] += content[i];
          }
        }
        const infos = [];
        let inc = 0;
        for (let i in dataTab) {
          const idx = dataTab[i].indexOf(":");
          if (idx + 1 !== dataTab[i].length) {
            infos[inc++] =
              dataTab[i].slice(0, idx) + " " + dataTab[i].slice(idx);
          }
        }
        setMapInfo([infos[0] || "", infos[1] || ""]);

        // Auto-select crop when clicking on a specific field
        const plainText = content.replace(/<[^>]+>/g, "\n");
        const mC = plainText.match(/Culture\s*:\s*([^\n]+)/i);
        if (mC) {
          const cName = normalizeCultureName(mC[1].trim());
          if (cName !== "N/A") {
            setSelectedCrop(cName);
          }
        }
      });

      window.google.maps.event.addListenerOnce(
        kmlLayer,
        "defaultviewport_changed",
        () => {
          const parser = new DOMParser();
          fetch(src)
            .then((r) => r.text())
            .then((kmlText) => {
              const kmlDoc = parser.parseFromString(kmlText, "text/xml");
              const placemarks = kmlDoc.getElementsByTagName("Placemark");

              let total = 0;
              let cTotals = {};
              const fieldPolygons = [];

              for (let i = 0; i < placemarks.length; i++) {
                let surface = 0;
                let cultureStr = "";

                const desc =
                  placemarks[i].getElementsByTagName("description")[0];
                if (desc) {
                  const m = desc.textContent.match(
                    /Surface\s*\(Ha\)\s*:\s*(\d+(\.\d+)?)/,
                  );
                  if (m) surface = parseFloat(m[1]);
                }

                const extendedData = placemarks[i].getElementsByTagName("Data");
                for (let j = 0; j < extendedData.length; j++) {
                  if (extendedData[j].getAttribute("name") === "Culture") {
                    const valueTag =
                      extendedData[j].getElementsByTagName("value")[0];
                    if (valueTag) cultureStr = valueTag.textContent;
                  }
                }

                if (!cultureStr && desc) {
                  const plainDesc = desc.textContent.replace(/<[^>]+>/g, "\n");
                  const mC = plainDesc.match(/Culture\s*:\s*([^\n]+)/i);
                  if (mC) cultureStr = mC[1].trim();
                }

                const polygonNodes =
                  placemarks[i].getElementsByTagName("Polygon");
                for (let p = 0; p < polygonNodes.length; p++) {
                  const coordinatesNode =
                    polygonNodes[p].getElementsByTagName("coordinates")[0];
                  if (!coordinatesNode) continue;

                  const points = coordinatesNode.textContent
                    .trim()
                    .split(/\s+/)
                    .map((tuple) => {
                      const [lng, lat] = tuple.split(",").map(Number);
                      return { lat, lng };
                    })
                    .filter(
                      (point) =>
                        Number.isFinite(point.lat) &&
                        Number.isFinite(point.lng),
                    );
                  if (points.length >= 3) fieldPolygons.push(points);
                }

                const cultureName = normalizeCultureName(cultureStr);
                cTotals[cultureName] = (cTotals[cultureName] || 0) + surface;
                total += surface;
              }
              setTotalHa(total.toFixed(2));
              setCropTotals(cTotals);
              fieldPolygonsRef.current = fieldPolygons;
            });
        },
      );

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
          selectedDateRef.current !== new Date().toISOString().slice(0, 10)
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

  const centerOnDevice = (deviceId) => {
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

  const formatSpeed = (pos) => {
    if (pos.speed == null) return null;
    return `${(pos.speed * 3.6).toFixed(1)} km/h`;
  };

  const getImplementWidth = (deviceId) => implementWidths[deviceId] ?? 3;

  const setDeviceWidth = (deviceId, value) => {
    setImplementWidths((previous) => ({ ...previous, [deviceId]: value }));
  };

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

    const tracksWithWidth = availableTrackDevices.map((deviceId) => ({
      deviceId,
      points: trackPointsByDeviceRef.current[deviceId],
      widthM: getImplementWidth(deviceId),
    }));

    setCalculatingCoverage(true);
    try {
      setCoverageResult(
        computeCoverageArea(fieldPolygonsRef.current, tracksWithWidth),
      );
    } catch (error) {
      setCoverageError(error.message || "Erreur de calcul");
    } finally {
      setCalculatingCoverage(false);
    }
  };

  return (
    <div className="fields-page">
      <Nav />
      <div id="mapCap">
        <div id="legend">
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

        <div id="map" ref={mapRef} />

        <div id="infoPanel">
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
            {coverageResult?.warnings?.length > 0 && (
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
            !availableDates.filter((date) => date.startsWith(`${year}-`)).length
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
  );
}
