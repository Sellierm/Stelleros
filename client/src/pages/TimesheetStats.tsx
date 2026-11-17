// Statistiques du pointage en graphiques (Chart.js, chargé à la demande),
// avec le tableau des chiffres repliable sous chaque graphique.

import { useEffect, useRef, useState } from "react";
import type { Chart, ChartConfiguration, TooltipItem } from "chart.js";
import { formatDuration, sumStats, type StatRow } from "../utils/timesheet";

type BarConfig = ChartConfiguration<"bar", number[], string>;

const TOP_ROUNDED = { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 };

/** Couleurs du thème courant (variables CSS, clair ou sombre). */
function readTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    morning: v("--ts-series-morning", "#1e8f72"),
    afternoon: v("--ts-series-afternoon", "#eb6834"),
    ink: v("--app-ink", "#17312a"),
    muted: v("--app-muted", "#6f837c"),
    line: v("--app-line", "rgba(23, 49, 42, 0.1)"),
    surface: v("--app-panel-solid", "#ffffff"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/** Change à chaque bascule clair / sombre (classe `dark-theme` sur <html>). */
function useThemeVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return version;
}

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

function rowDetails(row: StatRow): string[] {
  const lines = [
    `Total : ${formatDuration(row.total)}`,
    `${row.days} jour${row.days > 1 ? "s" : ""}` +
      (row.days
        ? ` · moyenne ${formatDuration(row.total / row.days)} / jour`
        : ""),
  ];
  if (row.doubled) lines.push(`dont x2 : ${formatDuration(row.doubled)}`);
  return lines;
}

function buildConfig(
  rows: StatRow[],
  label: (key: string) => string,
  tick: (key: string) => string,
  halves: boolean,
  horizontal: boolean,
): BarConfig {
  const theme = readTheme();
  const valueAxis = horizontal ? "x" : "y";
  const categoryAxis = horizontal ? "y" : "x";
  const base = {
    borderRadius: 4,
    borderSkipped: "start" as const,
    maxBarThickness: horizontal ? 22 : 28,
    categoryPercentage: 0.8,
    barPercentage: 0.9,
  };
  const datasets: BarConfig["data"]["datasets"] = halves
    ? [
        {
          ...base,
          label: "Matin",
          data: rows.map((r) => hours(r.morning)),
          backgroundColor: theme.morning,
          // Arrondi seulement en bout de pile (matin seul : pas d'après-midi
          // au-dessus) ; liseré clair entre les deux.
          borderRadius: (ctx: { dataIndex: number }) =>
            rows[ctx.dataIndex]?.afternoon ? 0 : TOP_ROUNDED,
          borderColor: theme.surface,
          borderWidth: { top: 2 },
        },
        {
          ...base,
          label: "Après-midi",
          data: rows.map((r) => hours(r.afternoon)),
          backgroundColor: theme.afternoon,
          borderSkipped: false,
          borderRadius: TOP_ROUNDED,
        },
      ]
    : [
        {
          ...base,
          label: "Heures",
          data: rows.map((r) => hours(r.total)),
          backgroundColor: theme.morning,
        },
      ];

  return {
    type: "bar",
    data: { labels: rows.map((r) => tick(r.key)), datasets },
    options: {
      font: { family: theme.font },
      indexAxis: horizontal ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        [categoryAxis]: {
          stacked: true,
          grid: { display: false },
          border: { color: theme.line },
          ticks: { color: theme.muted, autoSkip: true, maxRotation: 0 },
        },
        [valueAxis]: {
          stacked: true,
          beginAtZero: true,
          grid: { color: theme.line },
          border: { display: false },
          ticks: {
            color: theme.muted,
            maxTicksLimit: 6,
            callback: (value: string | number) => `${value} h`,
          },
        },
      },
      plugins: {
        legend: {
          display: halves,
          position: "top",
          align: "end",
          labels: {
            color: theme.ink,
            boxWidth: 12,
            boxHeight: 12,
            useBorderRadius: true,
            borderRadius: 3,
          },
        },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem<"bar">[]) =>
              items.length ? label(rows[items[0].dataIndex].key) : "",
            label: (item: TooltipItem<"bar">) => {
              const row = rows[item.dataIndex];
              if (!halves) return ` ${formatDuration(row.total)}`;
              const minutes =
                item.datasetIndex === 0 ? row.morning : row.afternoon;
              return ` ${item.dataset.label} : ${formatDuration(minutes)}`;
            },
            footer: (items: TooltipItem<"bar">[]) =>
              items.length
                ? rowDetails(rows[items[0].dataIndex]).slice(halves ? 0 : 1)
                : [],
          },
        },
      },
    },
  };
}

function BarChart({
  rows,
  label,
  tick,
  halves,
  horizontal,
  ariaLabel,
}: {
  rows: StatRow[];
  label: (key: string) => string;
  tick: (key: string) => string;
  halves: boolean;
  horizontal: boolean;
  ariaLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"bar", number[], string> | null>(null);
  const themeVersion = useThemeVersion();

  useEffect(() => {
    let cancelled = false;
    import("chart.js/auto").then(({ default: ChartJs }) => {
      if (cancelled || !canvasRef.current) return;
      chartRef.current?.destroy();
      chartRef.current = new ChartJs(
        canvasRef.current,
        buildConfig(rows, label, tick, halves, horizontal),
      );
    });
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [rows, label, tick, halves, horizontal, themeVersion]);

  const height = horizontal ? 48 + rows.length * 34 : 240;
  return (
    <div className="ts-chart" style={{ height }}>
      <canvas ref={canvasRef} role="img" aria-label={ariaLabel} />
    </div>
  );
}

// ─── Tableau des chiffres (replié) ────────────────────────────

function StatNumbers({
  column,
  rows,
  label,
  halves,
}: {
  column: string;
  rows: StatRow[];
  label: (key: string) => string;
  halves: boolean;
}) {
  const total = sumStats(rows);
  const showDoubled = total.doubled > 0;
  const cells = (row: StatRow) => (
    <>
      <td data-label="Jours" className="ts-num">
        {row.days}
      </td>
      {halves && (
        <>
          <td data-label="Matin" className="ts-num">
            {formatDuration(row.morning)}
          </td>
          <td data-label="Après-midi" className="ts-num">
            {formatDuration(row.afternoon)}
          </td>
        </>
      )}
      <td data-label="Heures" className="ts-num ts-day-total">
        {formatDuration(row.total)}
      </td>
      <td data-label="Moy./jour" className="ts-num">
        {formatDuration(row.days ? row.total / row.days : 0)}
      </td>
      {showDoubled && (
        <td data-label="dont x2" className="ts-num">
          {row.doubled ? formatDuration(row.doubled) : ""}
        </td>
      )}
    </>
  );

  return (
    <div className="ts-table-wrap">
      <table className="ts-table ts-stat-table">
        <thead>
          <tr>
            <th>{column}</th>
            <th>Jours</th>
            {halves && (
              <>
                <th>Matin</th>
                <th>Après-midi</th>
              </>
            )}
            <th>Heures</th>
            <th>Moy./jour</th>
            {showDoubled && (
              <th title="Heures ajoutées par les cases x2">dont x2</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((row) => row.days > 0)
            .map((row) => (
              <tr key={row.key}>
                <td className="ts-cell-date">{label(row.key)}</td>
                {cells(row)}
              </tr>
            ))}
        </tbody>
        {rows.length > 1 && (
          <tfoot>
            <tr>
              <td>Total</td>
              {cells(total)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ─── Carte : graphique + chiffres ─────────────────────────────

export interface StatCardProps {
  title: string;
  subtitle: string;
  column: string;
  rows: StatRow[];
  /** Libellé complet (infobulle, tableau). */
  label: (key: string) => string;
  /** Libellé court sous les barres (par défaut : `label`). */
  tick?: (key: string) => string;
  /** Barres empilées Matin / Après-midi. */
  halves?: boolean;
  /** Barres horizontales (une par personne). */
  horizontal?: boolean;
}

export function StatCard({
  title,
  subtitle,
  column,
  rows,
  label,
  tick,
  halves = false,
  horizontal = false,
}: StatCardProps) {
  const total = sumStats(rows);
  return (
    <section className="app-card ts-panel ts-stat-card">
      <div className="ts-panel-header">
        <div>
          <h2>{title}</h2>
          <span className="ts-subtitle">{subtitle}</span>
        </div>
        <strong className="ts-stat-total">{formatDuration(total.total)}</strong>
      </div>
      <BarChart
        rows={rows}
        label={label}
        tick={tick ?? label}
        halves={halves}
        horizontal={horizontal}
        ariaLabel={`${title} : ${rows
          .filter((r) => r.days > 0)
          .map((r) => `${label(r.key)} ${formatDuration(r.total)}`)
          .join(", ")}`}
      />
      <details className="ts-stat-details">
        <summary>Voir les chiffres</summary>
        <StatNumbers
          column={column}
          rows={rows}
          label={label}
          halves={halves}
        />
      </details>
    </section>
  );
}
