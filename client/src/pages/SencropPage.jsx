import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav.jsx";
import { useSocket } from "../contexts/SocketContext.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import "./SencropPage.css";

function toDateInputValue(date) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toJSON().slice(0, 10);
}

const today = toDateInputValue(new Date());

export default function SencropPage() {
  const socket = useSocket();
  const chart1Ref = useRef(null);
  const chart2Ref = useRef(null);
  const chartInst1 = useRef(null);
  const chartInst2 = useRef(null);
  const day1Ref = useRef(today);
  const day2Ref = useRef(today);

  const [loading1, setLoading1] = useState(false);
  const [loading2, setLoading2] = useState(false);

  usePageMeta(
    "Sencrop",
    "/assets/icons8-weather-station-wind-windows-10-32.png",
  );

  // Controls
  const [day1, setDay1] = useState(today);
  const [data1, setData1] = useState("TEMPERATURE");
  const [freq1, setFreq1] = useState("HOUR");

  const [day2, setDay2] = useState(today);
  const [data2, setData2] = useState("WIND_SPEED");
  const [freq2, setFreq2] = useState("HOUR");

  useEffect(() => {
    day1Ref.current = day1;
  }, [day1]);

  useEffect(() => {
    day2Ref.current = day2;
  }, [day2]);

  // ── Emit functions ──────────────────────────────────────────────────────────

  const emitR = (d = day1, dt = data1, f = freq1) => {
    if (!socket) return;
    setLoading1(true);
    if (chartInst1.current) {
      chartInst1.current.destroy();
      chartInst1.current = null;
    }

    const askedDay = new Date(d);
    askedDay.setHours(0);
    askedDay.setDate(askedDay.getDate() + 1);

    let measures = dt;
    if (f === "HOUR") {
      if (dt === "TEMPERATURE") measures += ",TEMPERATURE_MIN,TEMPERATURE_MAX";
      socket.emit("askDataR1", askedDay.toISOString(), measures);
    } else {
      socket.emit("askDataR2", askedDay.toISOString(), measures);
    }
  };

  const emitW = (d = day2, dt = data2, f = freq2) => {
    if (!socket) return;
    setLoading2(true);
    if (chartInst2.current) {
      chartInst2.current.destroy();
      chartInst2.current = null;
    }

    const askedDay = new Date(d);
    askedDay.setHours(0);
    askedDay.setDate(askedDay.getDate() + 1);

    if (f === "HOUR") socket.emit("askDataW1", askedDay.toISOString(), dt);
    else socket.emit("askDataW2", askedDay.toISOString(), dt);
  };

  // ── Socket listeners ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!socket) return;

    const drawChart = (canvasRef, instRef, config) => {
      import("chart.js/auto").then(({ default: Chart }) => {
        if (instRef.current) instRef.current.destroy();
        instRef.current = new Chart(canvasRef.current, config);
      });
    };

    const buildHoursLabels = (step = 1) => {
      const labels = [];
      for (let h = 0; h < 24; h++) labels.push(h + "h");
      return labels;
    };

    const buildMinLabels = (step) => {
      const labels = [];
      let h = 0,
        m = 0;
      while (h < 24) {
        labels.push(`${h}:${String(m).padStart(2, "0")}`);
        m += step;
        if (m >= 60) {
          h++;
          m = 0;
        }
      }

      return labels;
    };

    const getTodayCutoff = (step) => {
      const now = new Date();
      const cutoff = new Date(now);
      cutoff.setSeconds(0, 0);
      cutoff.setMinutes(Math.floor(now.getMinutes() / step) * step);
      return cutoff;
    };

    const toMinuteOfDay = (date) => date.getHours() * 60 + date.getMinutes();

    const isTodayInput = (value) => value === today;

    // ─ R1 (raincrop hourly) ─
    socket.on("getDataR1", (data, measures) => {
      setLoading1(false);
      const labels = buildHoursLabels();

      if (measures === "TEMPERATURE,TEMPERATURE_MIN,TEMPERATURE_MAX") {
        const temps = [],
          mins = [],
          maxs = [];
        data.forEach((r) => {
          temps.push(r.TEMPERATURE?.value);
          mins.push(r.TEMPERATURE_MIN?.value);
          maxs.push(r.TEMPERATURE_MAX?.value);
        });
        drawChart(chart1Ref, chartInst1, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: "Température (°C)",
                data: temps,
                backgroundColor: "rgba(240,99,132,1)",
                borderColor: "rgba(240,99,132,1)",
                pointHitRadius: 3,
                pointRadius: 1.5,
                borderWidth: 2.5,
              },
              {
                label: "Min/Max (°C)",
                data: mins,
                backgroundColor: "rgba(251,192,147,1)",
                pointRadius: 0,
                borderWidth: 0,
              },
              {
                label: "Min/Max (°C)",
                data: maxs,
                fill: "-1",
                backgroundColor: "rgba(251,192,147,1)",
                pointRadius: 0,
                borderWidth: 0,
              },
            ],
          },
          options: {
            animation: { duration: 0 },
            plugins: {
              title: { display: true, text: "Raincrop EARL" },
              legend: { labels: { filter: (item) => item.datasetIndex !== 2 } },
            },
          },
        });
      } else if (measures === "RELATIVE_HUMIDITY") {
        const vals = data.map((r) => r.RELATIVE_HUMIDITY?.value);
        drawChart(chart1Ref, chartInst1, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: "Hygrométrie (%)",
                data: vals,
                backgroundColor: "rgba(9,106,9,1)",
                borderColor: "rgba(9,106,9,1)",
                pointRadius: 1.5,
                borderWidth: 2.5,
              },
            ],
          },
          options: {
            animation: { duration: 0 },
            plugins: { title: { display: true, text: "Raincrop EARL" } },
          },
        });
      } else if (measures === "WET_TEMPERATURE") {
        const vals = data.map((r) => r.WET_TEMPERATURE?.value);
        drawChart(chart1Ref, chartInst1, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: "Température humide (°C)",
                data: vals,
                backgroundColor: "rgba(119,181,254,1)",
                borderColor: "rgba(119,181,254,1)",
                pointRadius: 1.5,
                borderWidth: 2.5,
              },
            ],
          },
          options: {
            animation: { duration: 0 },
            plugins: { title: { display: true, text: "Raincrop EARL" } },
          },
        });
      } else if (measures === "RAIN_FALL") {
        const vals = data.map((r) => r.RAIN_FALL?.value);
        drawChart(chart1Ref, chartInst1, {
          type: "bar",
          data: {
            labels,
            datasets: [
              {
                label: "Pluviométrie (mm)",
                data: vals,
                backgroundColor: "rgba(25,99,132,1)",
                borderColor: "rgba(25,99,132,1)",
              },
            ],
          },
          options: {
            animation: { duration: 0 },
            plugins: { title: { display: true, text: "Raincrop EARL" } },
            scales: { y: { beginAtZero: true } },
          },
        });
      }
    });

    // ─ R2 (raincrop 15min) ─
    socket.on("getDataR2", (data, measures) => {
      setLoading1(false);
      const labels = buildMinLabels(15);
      const cutoff = isTodayInput(day1Ref.current) ? getTodayCutoff(15) : null;
      const cutoffMinute = cutoff ? toMinuteOfDay(cutoff) : null;

      const labelIndexMap = Object.fromEntries(
        labels.map((label, index) => [label, index]),
      );
      const vals = new Array(labels.length).fill(undefined);
      data.forEach((row) => {
        const d = new Date(row.date);
        if (toDateInputValue(d) !== day1Ref.current) return;
        const rem = d.getMinutes() % 15;
        d.setMinutes(d.getMinutes() - rem, 0, 0);
        if (cutoffMinute != null && toMinuteOfDay(d) > cutoffMinute) return;
        const key = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
        const idx = labelIndexMap[key];
        if (idx !== undefined && row.value != null) vals[idx] = row.value;
      });
      const label =
        measures === "RAIN_FALL"
          ? "Pluviométrie (mm)"
          : measures === "RELATIVE_HUMIDITY"
            ? "Hygrométrie (%)"
            : measures === "WET_TEMPERATURE"
              ? "Température humide (°C)"
              : "Température (°C)";
      const type = measures === "RAIN_FALL" ? "bar" : "line";
      const color =
        measures === "RAIN_FALL"
          ? "rgba(25,99,132,1)"
          : measures === "RELATIVE_HUMIDITY"
            ? "rgba(9,106,9,1)"
            : measures === "WET_TEMPERATURE"
              ? "rgba(119,181,254,1)"
              : "rgba(240,99,132,1)";
      drawChart(chart1Ref, chartInst1, {
        type,
        data: {
          labels,
          datasets: [
            {
              label,
              data: vals,
              backgroundColor: color,
              borderColor: color,
              pointRadius: 1,
              borderWidth: 2.5,
            },
          ],
        },
        options: {
          animation: { duration: 0 },
          plugins: { title: { display: true, text: "Raincrop EARL" } },
          scales: type === "bar" ? { y: { beginAtZero: true } } : {},
        },
      });
    });

    // ─ W1 (windcrop hourly) ─
    socket.on("getDataW1", (data, measures) => {
      setLoading2(false);
      const labels = buildHoursLabels();
      let vals,
        label,
        color,
        opts = {};
      if (measures === "WIND_SPEED") {
        vals = data.map((r) => r.WIND_SPEED?.value);
        label = "Vitesse (km/h)";
        color = "rgba(127,127,127,1)";
      } else if (measures === "WIND_GUST") {
        vals = data.map((r) => r.WIND_GUST?.value);
        label = "Rafales (km/h)";
        color = "rgba(153,50,204,1)";
      } else {
        vals = data.map((r) => r.WIND_DIRECTION?.value);
        label = "Angle (°)";
        color = "rgba(127,127,127,1)";
        opts = { scales: { y: { min: 0, max: 359 } } };
      }
      drawChart(chart2Ref, chartInst2, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label,
              data: vals,
              backgroundColor: color,
              borderColor: color,
              pointHitRadius: 3,
              pointRadius: 1.5,
              borderWidth: 2.5,
            },
          ],
        },
        options: {
          animation: { duration: 0 },
          plugins: { title: { display: true, text: "Windcrop EARL" } },
          ...opts,
        },
      });
    });

    // ─ W2 (windcrop 10min) ─
    socket.on("getDataW2", (data, measures) => {
      setLoading2(false);
      const labels = buildMinLabels(10);
      const cutoff = isTodayInput(day2Ref.current) ? getTodayCutoff(10) : null;
      const cutoffMinute = cutoff ? toMinuteOfDay(cutoff) : null;

      const labelIndexMap = Object.fromEntries(
        labels.map((label, index) => [label, index]),
      );
      const vals = new Array(labels.length).fill(undefined);
      data.forEach((row) => {
        const d = new Date(row.date);
        if (toDateInputValue(d) !== day2Ref.current) return;
        const rem = d.getMinutes() % 10;
        d.setMinutes(d.getMinutes() - rem, 0, 0);
        if (cutoffMinute != null && toMinuteOfDay(d) > cutoffMinute) return;
        const key = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
        const idx = labelIndexMap[key];
        if (idx !== undefined && row.value != null) vals[idx] = row.value;
      });
      const label =
        measures === "WIND_SPEED" ? "Vitesse (km/h)" : "Rafales (km/h)";
      const color =
        measures === "WIND_GUST" ? "rgba(153,50,204,1)" : "rgba(127,127,127,1)";
      drawChart(chart2Ref, chartInst2, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label,
              data: vals,
              backgroundColor: color,
              borderColor: color,
              pointRadius: 1,
              borderWidth: 2.5,
            },
          ],
        },
        options: {
          animation: { duration: 0 },
          plugins: { title: { display: true, text: "Windcrop EARL" } },
        },
      });
    });

    return () => {
      socket.off("getDataR1");
      socket.off("getDataR2");
      socket.off("getDataW1");
      socket.off("getDataW2");
    };
  }, [socket]);

  // Initial load
  useEffect(() => {
    if (socket) {
      emitR();
      emitW();
    }
  }, [socket]); // eslint-disable-line

  // Cleanup charts on unmount
  useEffect(() => {
    return () => {
      if (chartInst1.current) chartInst1.current.destroy();
      if (chartInst2.current) chartInst2.current.destroy();
    };
  }, []);

  return (
    <div className="sencrop-page">
      <Nav />
      <div className="charts">
        <div className="box2">
          <div className="sencrop-chart-shell">
            {loading1 && (
              <div className="sencrop-loading-overlay">
                <img src="/assets/loading.gif" alt="loading" />
              </div>
            )}
            <canvas ref={chart1Ref} className={loading1 ? "is-hidden" : ""} />
          </div>
        </div>
        <div className="box2">
          <div className="sencrop-chart-shell">
            {loading2 && (
              <div className="sencrop-loading-overlay">
                <img src="/assets/loading.gif" alt="loading" />
              </div>
            )}
            <canvas ref={chart2Ref} className={loading2 ? "is-hidden" : ""} />
          </div>
        </div>
      </div>

      <div className="box1">
        <div>
          <label htmlFor="data1">
            <p>Type de donnée :</p>
          </label>
          <select
            id="data1"
            value={data1}
            onChange={(e) => {
              setData1(e.target.value);
              emitR(day1, e.target.value, freq1);
            }}
          >
            <option value="TEMPERATURE">Température</option>
            <option value="RAIN_FALL">Pluviométrie</option>
            <option value="RELATIVE_HUMIDITY">Hygrométrie</option>
            <option value="WET_TEMPERATURE">Température humide</option>
          </select>
        </div>
        <div>
          <label htmlFor="frequency1">
            <p>Fréquence :</p>
          </label>
          <select
            id="frequency1"
            value={freq1}
            onChange={(e) => {
              setFreq1(e.target.value);
              emitR(day1, data1, e.target.value);
            }}
          >
            <option value="HOUR">Heure</option>
            <option value="QUARTER">Quart d'heure</option>
          </select>
        </div>
        <div>
          <label htmlFor="data2">
            <p>Type de donnée :</p>
          </label>
          <select
            id="data2"
            value={data2}
            onChange={(e) => {
              setData2(e.target.value);
              emitW(day2, e.target.value, freq2);
            }}
          >
            <option value="WIND_SPEED">Vitesse</option>
            <option value="WIND_GUST">Rafales</option>
            <option value="WIND_DIRECTION">Angle</option>
          </select>
        </div>
        <div>
          <label htmlFor="frequency2">
            <p>Fréquence :</p>
          </label>
          <select
            id="frequency2"
            value={freq2}
            onChange={(e) => {
              setFreq2(e.target.value);
              emitW(day2, data2, e.target.value);
            }}
          >
            <option value="HOUR">Heure</option>
            <option value="TEN">Dizaine de minutes</option>
          </select>
        </div>
      </div>

      <div className="box1">
        <div>
          <label htmlFor="day1">
            <p>Date :</p>
          </label>
          <input
            id="day1"
            type="date"
            max={today}
            min="2020-11-07"
            value={day1}
            onChange={(e) => {
              setDay1(e.target.value);
              emitR(e.target.value, data1, freq1);
            }}
          />
        </div>
        <div>
          <label htmlFor="day2">
            <p>Date :</p>
          </label>
          <input
            id="day2"
            type="date"
            max={today}
            min="2020-11-07"
            value={day2}
            onChange={(e) => {
              setDay2(e.target.value);
              emitW(e.target.value, data2, freq2);
            }}
          />
        </div>
      </div>
    </div>
  );
}
