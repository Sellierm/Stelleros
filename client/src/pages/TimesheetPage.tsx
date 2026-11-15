import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import Nav from "../components/Nav";
import { useApiFetch } from "../hooks/useApiFetch";
import usePageMeta from "../hooks/usePageMeta";
import type {
  TimesheetEntry,
  TimesheetPayload,
  TimesheetUser,
  TimesheetUsersResponse,
} from "../types/api";
import {
  afternoonMinutes,
  dayMinutes,
  emptyPayload,
  entryToPayload,
  formatDayLabel,
  formatDuration,
  isoDate,
  monthPeriod,
  morningMinutes,
  validatePayload,
  yearPeriod,
  type Period,
} from "../utils/timesheet";
import "./TimesheetPage.css";

type PresetKey =
  "month" | "last-month" | "year" | "last-year" | "all" | "custom";

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "month", label: "Ce mois" },
  { key: "last-month", label: "Mois dernier" },
  { key: "year", label: "Cette année" },
  { key: "last-year", label: "Année dernière" },
  { key: "all", label: "Tout" },
  { key: "custom", label: "Personnalisée" },
];

function presetPeriod(key: PresetKey, now = new Date()): Period {
  switch (key) {
    case "month":
      return monthPeriod(now);
    case "last-month":
      return monthPeriod(now, -1);
    case "year":
      return yearPeriod(now);
    case "last-year":
      return yearPeriod(now, -1);
    default:
      return { from: "", to: "" };
  }
}

function periodQuery(userId: string, period: Period) {
  const params = new URLSearchParams();
  if (userId) params.set("user", userId);
  if (period.from) params.set("from", period.from);
  if (period.to) params.set("to", period.to);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function errorMessage(error: unknown, fallback: string) {
  return (error instanceof Error && error.message) || fallback;
}

function filenameFrom(disposition: string | null, fallback: string) {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  return match?.[1] ?? fallback;
}

// ─── Formulaire de saisie ─────────────────────────────────────

interface HalfDayFieldsProps {
  label: string;
  prefix: "morning" | "afternoon";
  form: TimesheetPayload;
  minutes: number;
  onChange: (key: keyof TimesheetPayload, value: string) => void;
}

function HalfDayFields({
  label,
  prefix,
  form,
  minutes,
  onChange,
}: HalfDayFieldsProps) {
  const start = `${prefix}_start` as const;
  const end = `${prefix}_end` as const;
  const tasks = `${prefix}_tasks` as const;
  const set =
    (key: keyof TimesheetPayload) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(key, e.target.value);
  const hasValue = Boolean(form[start] || form[end] || form[tasks]);

  return (
    <fieldset className="ts-half">
      <legend>
        <span>{label}</span>
        <span className="ts-half-total">{formatDuration(minutes)}</span>
      </legend>
      <div className="ts-times">
        <label>
          <span>Début</span>
          <input
            className="app-input"
            type="time"
            step={300}
            value={form[start]}
            onChange={set(start)}
          />
        </label>
        <label>
          <span>Fin</span>
          <input
            className="app-input"
            type="time"
            step={300}
            value={form[end]}
            onChange={set(end)}
          />
        </label>
        {hasValue && (
          <button
            type="button"
            className="ts-clear"
            title={`Vider ${label.toLowerCase()}`}
            onClick={() => {
              onChange(start, "");
              onChange(end, "");
              onChange(tasks, "");
            }}
          >
            ✕
          </button>
        )}
      </div>
      <label>
        <span>Travaux effectués</span>
        <textarea
          className="app-input"
          rows={2}
          maxLength={1000}
          value={form[tasks]}
          onChange={set(tasks)}
          placeholder="ex : labour, déchaumage…"
        />
      </label>
    </fieldset>
  );
}

interface EntryFormProps {
  editing: TimesheetEntry | null;
  saving: boolean;
  error: string;
  onSubmit: (payload: TimesheetPayload) => void;
  onCancel: () => void;
}

function EntryForm({
  editing,
  saving,
  error,
  onSubmit,
  onCancel,
}: EntryFormProps) {
  const [form, setForm] = useState<TimesheetPayload>(() =>
    editing ? entryToPayload(editing) : emptyPayload(isoDate(new Date())),
  );
  const [localError, setLocalError] = useState("");

  const onChange = (key: keyof TimesheetPayload, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setLocalError("");
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const message = validatePayload(form);
    if (message) {
      setLocalError(message);
      return;
    }
    onSubmit(form);
  };

  const shownError = localError || error;

  return (
    <form className="ts-form" onSubmit={submit}>
      <label className="ts-date">
        <span>Date</span>
        <input
          className="app-input"
          type="date"
          required
          value={form.date}
          onChange={(e) => onChange("date", e.target.value)}
        />
      </label>
      <HalfDayFields
        label="Matin"
        prefix="morning"
        form={form}
        minutes={morningMinutes(form)}
        onChange={onChange}
      />
      <HalfDayFields
        label="Après-midi"
        prefix="afternoon"
        form={form}
        minutes={afternoonMinutes(form)}
        onChange={onChange}
      />
      <div className="ts-form-total">
        <span>Total de la journée</span>
        <strong>{formatDuration(dayMinutes(form))}</strong>
      </div>
      {shownError && (
        <div className="ts-error" role="alert">
          {shownError}
        </div>
      )}
      <div className="ts-form-actions">
        {editing && (
          <button
            type="button"
            className="app-btn app-btn-ghost"
            onClick={onCancel}
          >
            Annuler
          </button>
        )}
        <button
          type="submit"
          className="app-btn app-btn-primary"
          disabled={saving}
        >
          {saving
            ? "Enregistrement…"
            : editing
              ? "Mettre à jour"
              : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}

// ─── Page ─────────────────────────────────────────────────────

export default function TimesheetPage() {
  const apiFetch = useApiFetch();
  usePageMeta("Pointage", "/assets/icons8-champ-32.png");

  const [me, setMe] = useState("");
  const [users, setUsers] = useState<TimesheetUser[]>([]);
  const [viewedUser, setViewedUser] = useState("");
  const [preset, setPreset] = useState<PresetKey>("year");
  const [period, setPeriod] = useState<Period>(() => presetPeriod("year"));
  const [entries, setEntries] = useState<TimesheetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<TimesheetEntry | null>(null);
  // Change à chaque enregistrement : remonte un formulaire vierge.
  const [formKey, setFormKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const isMine = !viewedUser || viewedUser === me;
  const viewedName = users.find((u) => u.id === (viewedUser || me))?.name ?? "";

  useEffect(() => {
    apiFetch<TimesheetUsersResponse>("/api/timesheet/users")
      .then((res) => {
        setMe(res.me);
        setUsers(res.users);
        setViewedUser((current) => current || res.me);
      })
      .catch((error) => {
        setLoadError(
          errorMessage(error, "Impossible de charger les utilisateurs"),
        );
        setLoading(false);
      });
  }, [apiFetch]);

  const loadEntries = useCallback(async () => {
    if (!viewedUser) return;
    setLoading(true);
    setLoadError("");
    try {
      const rows = await apiFetch<TimesheetEntry[]>(
        `/api/timesheet/entries${periodQuery(viewedUser, period)}`,
      );
      setEntries(rows);
    } catch (error) {
      setLoadError(errorMessage(error, "Impossible de charger les journées"));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, viewedUser, period]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.date.localeCompare(a.date)),
    [entries],
  );

  const stats = useMemo(() => {
    const total = entries.reduce((sum, e) => sum + dayMinutes(e), 0);
    const days = entries.filter((e) => dayMinutes(e) > 0).length;
    return { total, days, average: days ? total / days : 0 };
  }, [entries]);

  const choosePreset = (key: PresetKey) => {
    setPreset(key);
    if (key !== "custom") setPeriod(presetPeriod(key));
  };

  const resetForm = () => {
    setEditing(null);
    setSaveError("");
    setFormKey((k) => k + 1);
  };

  const save = async (payload: TimesheetPayload) => {
    setSaving(true);
    setSaveError("");
    try {
      await apiFetch(
        editing
          ? `/api/timesheet/entries/${editing.id}`
          : "/api/timesheet/entries",
        {
          method: editing ? "PUT" : "POST",
          body: JSON.stringify(payload),
        },
      );
      resetForm();
      await loadEntries();
    } catch (error) {
      setSaveError(errorMessage(error, "Enregistrement impossible"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: TimesheetEntry) => {
    setConfirmDelete(null);
    try {
      await apiFetch(`/api/timesheet/entries/${entry.id}`, {
        method: "DELETE",
      });
      if (editing?.id === entry.id) resetForm();
      await loadEntries();
    } catch (error) {
      setLoadError(errorMessage(error, "Suppression impossible"));
    }
  };

  const startEdit = (entry: TimesheetEntry) => {
    setEditing(entry);
    setSaveError("");
    setFormKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const exportExcel = async () => {
    setExporting(true);
    setExportError("");
    try {
      const res = await fetch(
        `/api/timesheet/export${periodQuery(viewedUser, period)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(
        res.headers.get("content-disposition"),
        "heures.xlsx",
      );
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Impossible de générer le fichier Excel.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="timesheet-page app-page">
      <Nav />
      <div className="ts-page">
        <div className="ts-summary-grid">
          <div className="ts-summary-card">
            <span className="app-kicker">Heures sur la période</span>
            <strong>{formatDuration(stats.total)}</strong>
          </div>
          <div className="ts-summary-card">
            <span className="app-kicker">Jours travaillés</span>
            <strong>{stats.days}</strong>
          </div>
          <div className="ts-summary-card">
            <span className="app-kicker">Moyenne par jour</span>
            <strong>{formatDuration(stats.average)}</strong>
          </div>
        </div>

        <div className="ts-layout">
          <section className="app-card ts-panel ts-panel-form">
            <div className="ts-panel-header">
              <div>
                <h2>
                  {editing
                    ? `Modifier le ${formatDayLabel(editing.date)}`
                    : isMine
                      ? "Nouvelle journée"
                      : "Saisie"}
                </h2>
                <span className="ts-subtitle">
                  {isMine
                    ? "Horaires du matin et de l'après-midi"
                    : "Lecture seule"}
                </span>
              </div>
            </div>
            {isMine ? (
              <EntryForm
                key={formKey}
                editing={editing}
                saving={saving}
                error={saveError}
                onSubmit={save}
                onCancel={resetForm}
              />
            ) : (
              <div className="ts-empty">
                Vous consultez les heures de <strong>{viewedName}</strong>{" "}
                (lecture seule).{" "}
                <button
                  type="button"
                  className="ts-link"
                  onClick={() => setViewedUser(me)}
                >
                  Revenir à mes heures
                </button>
              </div>
            )}
          </section>

          <section className="app-card ts-panel ts-panel-list">
            <div className="ts-panel-header">
              <div>
                <h2>Journées</h2>
                <span className="ts-subtitle">
                  {viewedName ? `Heures de ${viewedName}` : "Historique"}
                </span>
              </div>
              <button
                type="button"
                className="app-btn app-btn-ghost"
                onClick={exportExcel}
                disabled={exporting || !viewedUser}
                title="Exporter la période en Excel"
              >
                {exporting ? "Export…" : "⬇ Excel"}
              </button>
            </div>

            <div className="ts-toolbar">
              {users.length > 1 && (
                <select
                  className="app-input ts-select"
                  value={viewedUser}
                  onChange={(e) => {
                    setViewedUser(e.target.value);
                    setEditing(null);
                    setConfirmDelete(null);
                  }}
                  aria-label="Utilisateur"
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                      {u.id === me ? " (moi)" : ""}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="app-input ts-select"
                value={preset}
                onChange={(e) => choosePreset(e.target.value as PresetKey)}
                aria-label="Période"
              >
                {PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              {preset === "custom" && (
                <div className="ts-range">
                  <input
                    className="app-input"
                    type="date"
                    value={period.from}
                    max={period.to || undefined}
                    onChange={(e) =>
                      setPeriod((p) => ({ ...p, from: e.target.value }))
                    }
                    aria-label="Du"
                  />
                  <span>→</span>
                  <input
                    className="app-input"
                    type="date"
                    value={period.to}
                    min={period.from || undefined}
                    onChange={(e) =>
                      setPeriod((p) => ({ ...p, to: e.target.value }))
                    }
                    aria-label="Au"
                  />
                </div>
              )}
            </div>

            {(loadError || exportError) && (
              <div className="ts-error ts-error-panel" role="alert">
                {loadError || exportError}
              </div>
            )}

            {loading ? (
              <div className="ts-empty">Chargement…</div>
            ) : sorted.length === 0 ? (
              <div className="ts-empty">Aucune journée sur cette période.</div>
            ) : (
              <div className="ts-table-wrap">
                <table className="ts-table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Date</th>
                      <th colSpan={3}>Matin</th>
                      <th colSpan={3}>Après-midi</th>
                      <th rowSpan={2}>Total</th>
                      {isMine && <th rowSpan={2} aria-label="Actions" />}
                    </tr>
                    <tr>
                      <th>Horaires</th>
                      <th>Durée</th>
                      <th>Travaux</th>
                      <th>Horaires</th>
                      <th>Durée</th>
                      <th>Travaux</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((entry) => {
                      const morning = morningMinutes(entry);
                      const afternoon = afternoonMinutes(entry);
                      return (
                        <tr
                          key={entry.id}
                          className={
                            editing?.id === entry.id
                              ? "ts-row-active"
                              : undefined
                          }
                        >
                          <td className="ts-cell-date">
                            {formatDayLabel(entry.date)}
                          </td>
                          <td data-label="Matin">
                            {morning
                              ? `${entry.morning_start} – ${entry.morning_end}`
                              : "—"}
                          </td>
                          <td data-label="Durée" className="ts-num">
                            {morning ? formatDuration(morning) : ""}
                          </td>
                          <td data-label="Travaux" className="ts-tasks">
                            {entry.morning_tasks}
                          </td>
                          <td data-label="Après-midi">
                            {afternoon
                              ? `${entry.afternoon_start} – ${entry.afternoon_end}`
                              : "—"}
                          </td>
                          <td data-label="Durée" className="ts-num">
                            {afternoon ? formatDuration(afternoon) : ""}
                          </td>
                          <td data-label="Travaux" className="ts-tasks">
                            {entry.afternoon_tasks}
                          </td>
                          <td
                            data-label="Total"
                            className="ts-num ts-day-total"
                          >
                            {formatDuration(morning + afternoon)}
                          </td>
                          {isMine && (
                            <td className="ts-actions">
                              {confirmDelete === entry.id ? (
                                <>
                                  <button
                                    type="button"
                                    className="ts-icon-btn ts-icon-btn-danger"
                                    onClick={() => remove(entry)}
                                  >
                                    Supprimer
                                  </button>
                                  <button
                                    type="button"
                                    className="ts-icon-btn"
                                    onClick={() => setConfirmDelete(null)}
                                  >
                                    Non
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="ts-icon-btn"
                                    title="Modifier"
                                    onClick={() => startEdit(entry)}
                                  >
                                    ✏️
                                  </button>
                                  <button
                                    type="button"
                                    className="ts-icon-btn ts-icon-btn-danger"
                                    title="Supprimer"
                                    onClick={() => setConfirmDelete(entry.id)}
                                  >
                                    🗑️
                                  </button>
                                </>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={7}>Total</td>
                      <td className="ts-num ts-day-total">
                        {formatDuration(stats.total)}
                      </td>
                      {isMine && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
