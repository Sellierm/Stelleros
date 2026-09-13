import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import "./ForecastPage.css";

const DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
const MONTHS = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];
const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(dt) {
  const d = new Date(dt * 1000);
  const h = d.getHours();
  return h === 0 ? d.getDate() + " " + MONTHS[d.getMonth()] : h + "h";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// ── DayDetail component ───────────────────────────────────────────────────────

function DayDetail({ day, dailyData, onClose, onChangeDay }) {
  const scrollerRef = useRef(null);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const activeElement = scroller.querySelector("li.active");
      if (activeElement) {
        const containerWidth = scroller.clientWidth;
        const elementWidth = activeElement.offsetWidth;
        const elementOffset = activeElement.offsetLeft;
        const scrollToCenter =
          elementOffset -
          containerWidth / 2 +
          elementWidth / 2 -
          (window.innerWidth > 1000 ? 10 : 0);

        scroller.scrollLeft = scrollToCenter;
      }
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [day, dailyData]);

  return (
    <div className="scrolling-container">
      <div className="scrolling-container-header">
        <ul className="options-scroller" ref={scrollerRef}>
          {dailyData.map((d, i) => {
            const date = new Date(d.dt * 1000);
            return (
              <li
                key={i}
                className={d === day ? "active" : ""}
                onClick={() => (d === day ? onClose() : onChangeDay(d))}
              >
                {DAYS[date.getDay()]} {pad2(date.getDate())}{" "}
                {MONTHS[date.getMonth()]}
              </li>
            );
          })}
        </ul>
        <span className="chevron-container" onClick={onClose}>
          <img
            src="/assets/1141405.png"
            style={{ width: 12, height: 12 }}
            alt="back"
          />
        </span>
      </div>

      <div className="scrolling-container-content">
        <div className="daily-detail-container">
          {/* Top */}
          <div className="top-section">
            <img
              className="owm-weather-icon"
              src={`https://openweathermap.org/img/wn/${day.weather[0].icon}.png`}
              alt={day.weather[0].description}
            />
            <div>
              <p style={{ fontWeight: 700 }}>{day.weather[0].description}</p>
              <p>
                The high will be {day.temp.max}°C, the low will be{" "}
                {day.temp.min}°C.
              </p>
            </div>
          </div>

          {/* Weather items */}
          <ul className="weather-items text-container orange-side standard-padding">
            <li>
              <img src="/assets/rain.png" className="icon-snow" alt="rain" />
              <span>
                {day.rain
                  ? `${day.rain} mm (${Math.round(day.pop * 100)}%)`
                  : day.snow
                    ? `${day.snow} mm (${day.pop * 100}%)`
                    : `${Math.round(day.pop * 100)}%`}
              </span>
            </li>
            <li>
              <img
                src="/assets/wind.png"
                className="icon-wind-direction"
                style={{ transform: `rotate(${90 + day.wind_deg}deg)` }}
                alt="wind"
              />
              <span>
                {day.wind_speed} m/s{" "}
                {DIRECTIONS[Math.round(day.wind_deg / 45) % 8]}
              </span>
            </li>
            <li>
              <img
                src="/assets/pressure.png"
                className="icon-wind-direction"
                alt="pressure"
              />
              <span>{day.pressure} hPa</span>
            </li>
            <li>
              <span className="symbol">humidity: {day.humidity}%</span>
            </li>
            <li>
              <span className="symbol">UV: {day.uvi}</span>
            </li>
            <li>
              <span className="symbol">Dew point: {day.dew_point}°C</span>
            </li>
          </ul>

          {/* Temp table */}
          <table>
            <tbody>
              <tr>
                <th></th>
                <th>Morning</th>
                <th>Afternoon</th>
                <th>Evening</th>
                <th>Night</th>
              </tr>
              <tr>
                <td>TEMPERATURE</td>
                <td>{day.temp.morn}°C</td>
                <td>{day.temp.day}°C</td>
                <td>{day.temp.eve}°C</td>
                <td>{day.temp.night}°C</td>
              </tr>
              <tr>
                <td>FEELS_LIKE</td>
                <td>{day.feels_like.morn}°C</td>
                <td>{day.feels_like.day}°C</td>
                <td>{day.feels_like.eve}°C</td>
                <td>{day.feels_like.night}°C</td>
              </tr>
            </tbody>
          </table>

          {/* Sunrise / Sunset */}
          <div className="item-container">
            {[
              { label: "SUNRISE", ts: day.sunrise },
              { label: "SUNSET", ts: day.sunset },
              { label: "MOONRISE", ts: day.moonrise },
              { label: "MOONSET", ts: day.moonset },
            ].map(({ label, ts }) => {
              const d = new Date(ts * 1000);
              return (
                <div className="item" key={label}>
                  <span className="label">{label}</span>
                  <span className="value">
                    {pad2(d.getHours())}:{pad2(d.getMinutes())}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ForecastPage ──────────────────────────────────────────────────────────────

export default function ForecastPage() {
  const lineChartRef = useRef(null);
  const yAxisRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [forecastData, setForecastData] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const chartInstances = useRef({});

  usePageMeta("Forecast", "/assets/icons8-weather-forecast-32.png");

  useEffect(() => {
    fetch("/api/forecast", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setForecastData(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Build charts once data arrives
  useEffect(() => {
    if (!forecastData || loading) return;

    import("chart.js/auto").then(({ default: Chart }) => {
      const hourlyData = forecastData.hourly || [];
      const times = hourlyData.map((h) => fmtTime(h.dt));
      const temperatures = hourlyData.map((h) => h.temp);
      const rains = hourlyData.map((h) =>
        h.rain && h.rain["1h"] ? h.rain["1h"] : 0,
      );

      // Destroy previous instances
      if (chartInstances.current.line) chartInstances.current.line.destroy();
      if (chartInstances.current.scale) chartInstances.current.scale.destroy();

      chartInstances.current.scale = new Chart(yAxisRef.current, {
        type: "line",
        data: { labels: times, datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: -31 } },
          scales: {
            x: {
              grid: { display: false },
              border: { display: false },
              position: "top",
              ticks: { color: "rgba(255,255,255,0)" },
            },
            y: {
              grid: { display: false },
              border: { display: false },
              ticks: {
                color: "rgb(255,140,0)",
                callback: (value, index, values) =>
                  index === values.length - 1 ? "" : value,
              },
              suggestedMin: Math.floor(Math.min(...temperatures)) - 0.5,
              suggestedMax: Math.floor(Math.max(...temperatures)) + 1,
            },
          },
          plugins: { legend: { display: false } },
        },
      });

      chartInstances.current.line = new Chart(lineChartRef.current, {
        data: {
          labels: times,
          datasets: [
            {
              type: "line",
              label: "Température(°C)",
              data: temperatures,
              borderColor: "rgb(255,140,0)",
              yAxisID: "left",
              pointRadius: 0.01,
              borderWidth: 1.5,
            },
            {
              type: "bar",
              label: "Pluie (mm)",
              data: rains,
              borderColor: "rgb(255,255,255)",
              backgroundColor: "rgb(176,224,230)",
              yAxisID: "right",
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: false,
          maintainAspectRatio: false,
          elements: { line: { tension: 0.5 } },
          scales: {
            x: {
              grid: { display: false },
              border: { display: false },
              position: "top",
            },
            left: {
              suggestedMin: Math.floor(Math.min(...temperatures)) - 0.5,
              suggestedMax: Math.floor(Math.max(...temperatures)) + 1,
              display: false,
            },
            right: {
              display: false,
              position: "right",
              suggestedMax: Math.floor(Math.max(...rains)) + 1,
              suggestedMin: 0,
            },
          },
          plugins: { legend: { display: false } },
        },
      });
    });
  }, [forecastData, loading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (chartInstances.current.line) chartInstances.current.line.destroy();
      if (chartInstances.current.scale) chartInstances.current.scale.destroy();
    };
  }, []);

  const dailyData = forecastData?.daily || [];

  return (
    <>
      <Nav />
      <div className="forecast-page">
        <div className="forecast">
          {/* Hourly */}
          <div className="hourly">
            {loading ? (
              <div className="forecast-loading forecast-loading-hourly">
                <img src="/assets/loading.gif" alt="loading" />
              </div>
            ) : (
              <div className="hourly-scroll-area">
                <div className="y-axis-container">
                  <canvas ref={yAxisRef} height={400} width={3500} />
                </div>
                <div className="chart-wrapper">
                  <canvas ref={lineChartRef} height={400} width={3500} />
                </div>
              </div>
            )}
          </div>

          {/* Daily */}
          <div className="daily">
            {loading ? (
              <div className="forecast-loading forecast-loading-daily">
                <img src="/assets/loading.gif" alt="loading" />
              </div>
            ) : selectedDay ? (
              <DayDetail
                day={selectedDay}
                dailyData={dailyData}
                onClose={() => setSelectedDay(null)}
                onChangeDay={(d) => setSelectedDay(d)}
              />
            ) : (
              <ul id="forecast-container" className="day-list">
                {dailyData.map((day, i) => {
                  const date = new Date(day.dt * 1000);
                  return (
                    <li key={i} onClick={() => setSelectedDay(day)}>
                      <span>
                        {DAYS[date.getDay()]} {pad2(date.getDate())}{" "}
                        {MONTHS[date.getMonth()]}
                      </span>
                      <div className="day-list-values">
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "flex-start",
                            alignItems: "center",
                          }}
                        >
                          <img
                            src={`https://openweathermap.org/img/wn/${day.weather[0].icon}.png`}
                            alt=""
                          />
                          <span>
                            {Math.round(day.temp.max)} /{" "}
                            {Math.round(day.temp.min)}°C
                          </span>
                        </div>
                        <span
                          style={{
                            width: 100,
                            textAlign: "right",
                            color: "#8a8a8a",
                            fontSize: 10,
                          }}
                        >
                          {day.weather[0].description}
                        </span>
                        <img
                          src="/assets/1141402.png"
                          style={{ width: 12, height: 12 }}
                          alt=">"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
