import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav";
import usePageMeta from "../hooks/usePageMeta";
import type { ConfigResponse } from "../types/api";
import "./GpsPage.css";

class KalmanFilter {
  R: number;
  Q: number;
  P: number;
  X: number;

  constructor(R = 0.01, Q = 3) {
    this.R = R;
    this.Q = Q;
    this.P = 1;
    this.X = 0;
  }
  update(measurement: number) {
    this.P += this.Q;
    const K = this.P / (this.P + this.R);
    this.X += K * (measurement - this.X);
    this.P *= 1 - K;
    return this.X;
  }
}

interface AbPositions {
  lat: number | null;
  lng: number | null;
  latA: number | null;
  lngA: number | null;
  latB: number | null;
  lngB: number | null;
}

export default function GpsPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapsKey, setMapsKey] = useState("");
  const [width, setWidth] = useState(1);
  const [space, setSpace] = useState(1);
  const [length, setLength] = useState(1);
  const [mapOpen, setMapOpen] = useState(false);
  const [aDefined, setADefined] = useState(false);
  const [bDefined, setBDefined] = useState(false);
  const posRef = useRef<AbPositions>({
    lat: null,
    lng: null,
    latA: null,
    lngA: null,
    latB: null,
    lngB: null,
  });
  const kalmanRef = useRef({
    lat: new KalmanFilter(),
    lng: new KalmanFilter(),
  });
  const watchIdRef = useRef<number | null>(null);
  const mapIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  usePageMeta("Gps", "/assets/icons8-gps-32.png");

  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.json() as Promise<ConfigResponse>)
      .then((d) => setMapsKey(d.googleMapsApiKey ?? ""));
  }, []);

  // Watch GPS position
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        posRef.current.lat = pos.coords.latitude;
        posRef.current.lng = pos.coords.longitude;
      },
      (err) => console.error("Geolocation error:", err.message),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
    );
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (mapIntervalRef.current !== null) {
        clearInterval(mapIntervalRef.current);
        mapIntervalRef.current = null;
      }
    };
  }, []);

  const defineA = () => {
    posRef.current.latA = posRef.current.lat;
    posRef.current.lngA = posRef.current.lng;
    setADefined(true);
  };

  const defineB = () => {
    posRef.current.latB = posRef.current.lat;
    posRef.current.lngB = posRef.current.lng;
    setBDefined(true);
  };

  const openMap = () => {
    const { latA, lngA, latB, lngB } = posRef.current;
    // Point défini avant le premier relevé GPS.
    if (latA === null || lngA === null || latB === null || lngB === null) {
      alert("Position GPS indisponible : redéfinir les points A et B.");
      return;
    }
    if (
      isNaN(width) ||
      isNaN(space) ||
      isNaN(length) ||
      width <= 0 ||
      space <= 0 ||
      length <= 0
    ) {
      alert(
        "Please enter valid positive numbers for width, space, and length.",
      );
      return;
    }

    const initMap = () => {
      if (!mapRef.current) return;

      const map = new google.maps.Map(mapRef.current, {
        center: { lat: latB, lng: lngB },
        zoom: 19,
        tilt: 0,
        heading: 320,
        mapTypeId: "satellite",
      });

      const headingAB = google.maps.geometry.spherical.computeHeading(
        { lat: latA, lng: lngA },
        { lat: latB, lng: lngB },
      );

      const pointC = google.maps.geometry.spherical.computeOffset(
        { lat: latA, lng: lngA },
        length,
        headingAB,
      );
      const pointA = google.maps.geometry.spherical.computeOffset(
        { lat: latA, lng: lngA },
        length,
        headingAB + 180,
      );

      // Lignes de guidage
      for (let i = -150; i < 150; i++) {
        const offset = space * i;
        new google.maps.Polyline({
          path: [
            google.maps.geometry.spherical.computeOffset(
              pointA,
              offset,
              headingAB + 90,
            ),
            google.maps.geometry.spherical.computeOffset(
              pointC,
              offset,
              headingAB + 90,
            ),
          ],
          geodesic: true,
          strokeColor: "#0000FF",
          strokeOpacity: 1.0,
          strokeWeight: 2,
        }).setMap(map);
      }

      // Ligne A-B
      new google.maps.Polyline({
        path: [pointA, pointC],
        geodesic: true,
        strokeColor: "#00FF00",
        strokeOpacity: 1.0,
        strokeWeight: 2,
      }).setMap(map);

      map.setHeading(headingAB);
      setMapOpen(true);

      // Suivi de position
      const showPosition = (pos: GeolocationPosition) => {
        const lat = kalmanRef.current.lat.update(pos.coords.latitude);
        const lng = kalmanRef.current.lng.update(pos.coords.longitude);
        map.setCenter({ lat, lng });
        new google.maps.Circle({
          strokeColor: "#FF0000",
          strokeOpacity: 0.8,
          strokeWeight: 2,
          fillColor: "#FF0000",
          fillOpacity: 0.2,
          map,
          center: { lat, lng },
          radius: width / 2,
        }).setMap(map);
      };

      mapIntervalRef.current = setInterval(
        () => navigator.geolocation.getCurrentPosition(showPosition),
        1000,
      );
    };

    if (window.google && window.google.maps) {
      initMap();
    } else {
      window.__farmGpsLoaded = initMap;
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${mapsKey}&libraries=geometry&v=weekly&callback=__farmGpsLoaded`;
      script.async = true;
      document.head.appendChild(script);
    }
  };

  const fields = [
    {
      id: "width",
      label: "Largeur de l'outil",
      hint: "Largeur de la trace en mètres",
      value: width,
      onChange: setWidth,
    },
    {
      id: "space",
      label: "Espace entre les lignes",
      hint: "Espace entre les lignes en mètres",
      value: space,
      onChange: setSpace,
    },
    {
      id: "length",
      label: "Longueur de la ligne",
      hint: "Longueur de la ligne en mètres",
      value: length,
      onChange: setLength,
    },
  ];

  return (
    <div className="gps-page app-page">
      <Nav />
      {!mapOpen && (
        <main className="gps-dashboard">
          <section className="gps-card app-card">
            <span className="app-kicker">Guidage A-B</span>
            <h2>Paramètres de la trace</h2>

            <div className="gps-fields">
              {fields.map(({ id, label, hint, value, onChange }) => (
                <div className="gps-field" key={id}>
                  <label htmlFor={id}>{label}</label>
                  <input
                    type="number"
                    className="app-input"
                    id={id}
                    value={value}
                    onChange={(e) => onChange(parseFloat(e.target.value))}
                  />
                  <span className="gps-hint">{hint}</span>
                </div>
              ))}
            </div>

            <div className="gps-points">
              <button
                className={`app-btn ${aDefined ? "app-btn-ghost gps-point-set" : "app-btn-primary"}`}
                onClick={defineA}
              >
                {aDefined ? "✓ Point A défini" : "Définir A"}
              </button>
              <button
                className={`app-btn ${bDefined ? "app-btn-ghost gps-point-set" : "app-btn-primary"}`}
                onClick={defineB}
              >
                {bDefined ? "✓ Point B défini" : "Définir B"}
              </button>
            </div>

            {aDefined && bDefined && (
              <button
                className="app-btn app-btn-primary gps-open-map"
                onClick={openMap}
              >
                Ouvrir la carte
              </button>
            )}
          </section>
        </main>
      )}
      <div
        ref={mapRef}
        id="map"
        style={{
          display: mapOpen ? "block" : "none",
          height: mapOpen ? `calc(100vh - 56px)` : 0,
          width: "100%",
        }}
      />
    </div>
  );
}
