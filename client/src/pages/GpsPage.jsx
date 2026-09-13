import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import "./GpsPage.css";

class KalmanFilter {
  constructor(R = 0.01, Q = 3) {
    this.R = R;
    this.Q = Q;
    this.P = 1;
    this.X = 0;
  }
  update(measurement) {
    this.P += this.Q;
    const K = this.P / (this.P + this.R);
    this.X += K * (measurement - this.X);
    this.P *= 1 - K;
    return this.X;
  }
}

export default function GpsPage() {
  const mapRef = useRef(null);
  const [mapsKey, setMapsKey] = useState("");
  const [width, setWidth] = useState(1);
  const [space, setSpace] = useState(1);
  const [length, setLength] = useState(1);
  const [mapOpen, setMapOpen] = useState(false);
  const [aDefined, setADefined] = useState(false);
  const [bDefined, setBDefined] = useState(false);
  const posRef = useRef({
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
  const watchIdRef = useRef(null);
  const mapIntervalRef = useRef(null);

  usePageMeta("Gps", "/assets/icons8-gps-32.png");

  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setMapsKey(d.googleMapsApiKey));
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
      const map = new window.google.maps.Map(mapRef.current, {
        center: { lat: latB, lng: lngB },
        zoom: 19,
        tilt: 0,
        heading: 320,
        mapTypeId: "satellite",
      });

      const headingAB = window.google.maps.geometry.spherical.computeHeading(
        { lat: latA, lng: lngA },
        { lat: latB, lng: lngB },
      );

      const pointC = window.google.maps.geometry.spherical.computeOffset(
        { lat: latA, lng: lngA },
        length,
        headingAB,
      );
      const pointA = window.google.maps.geometry.spherical.computeOffset(
        { lat: latA, lng: lngA },
        length,
        headingAB + 180,
      );

      // Lignes de guidage
      for (let i = -150; i < 150; i++) {
        const offset = space * i;
        new window.google.maps.Polyline({
          path: [
            window.google.maps.geometry.spherical.computeOffset(
              pointA,
              offset,
              headingAB + 90,
            ),
            window.google.maps.geometry.spherical.computeOffset(
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
      new window.google.maps.Polyline({
        path: [pointA, pointC],
        geodesic: true,
        strokeColor: "#00FF00",
        strokeOpacity: 1.0,
        strokeWeight: 2,
      }).setMap(map);

      map.setHeading(headingAB);
      setMapOpen(true);

      // Suivi de position
      const showPosition = (pos) => {
        const lat = kalmanRef.current.lat.update(pos.coords.latitude);
        const lng = kalmanRef.current.lng.update(pos.coords.longitude);
        map.setCenter({ lat, lng });
        new window.google.maps.Circle({
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

  return (
    <>
      <Nav />
      {!mapOpen && (
        <div className="container">
          <div className="mb-3">
            <label htmlFor="width" className="form-label">
              Largeur de l'outil
            </label>
            <input
              type="number"
              className="form-control"
              id="width"
              value={width}
              onChange={(e) => setWidth(parseFloat(e.target.value))}
            />
            <div className="form-text">Largeur de la trace en mètres</div>
          </div>
          <div className="mb-3">
            <label htmlFor="space" className="form-label">
              Espace entre les lignes
            </label>
            <input
              type="number"
              className="form-control"
              id="space"
              value={space}
              onChange={(e) => setSpace(parseFloat(e.target.value))}
            />
            <div className="form-text">Espace entre les lignes en mètres.</div>
          </div>
          <div className="mb-3">
            <label htmlFor="length" className="form-label">
              Longueur de la ligne
            </label>
            <input
              type="number"
              className="form-control"
              id="length"
              value={length}
              onChange={(e) => setLength(parseFloat(e.target.value))}
            />
            <div className="form-text">Longueur de la ligne en mètres.</div>
          </div>
          <div className="mb-3 form-check">
            <button
              className={`btn ${aDefined ? "btn-success" : "btn-primary"}`}
              onClick={defineA}
            >
              Définir A
            </button>
          </div>
          <div className="mb-3 form-check">
            <button
              className={`btn ${bDefined ? "btn-success" : "btn-primary"}`}
              onClick={defineB}
            >
              Définir B
            </button>
          </div>
          {aDefined && bDefined && (
            <div className="mb-3 form-check">
              <button className="btn btn-primary" onClick={openMap}>
                OUVRIR LA CARTE
              </button>
            </div>
          )}
        </div>
      )}
      <div
        ref={mapRef}
        id="map"
        style={{
          display: mapOpen ? "block" : "none",
          height: mapOpen ? `calc(100vh - 60px)` : 0,
          width: "100%",
        }}
      />
    </>
  );
}
