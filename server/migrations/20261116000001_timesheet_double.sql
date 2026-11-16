-- Case « x2 » par demi-journée : ses heures comptent double (travail fait à
-- deux, par exemple). Les horaires restent ceux saisis ; seuls les totaux
-- sont doublés.

ALTER TABLE timesheet_entries
  ADD COLUMN IF NOT EXISTS morning_double tinyint(1) NOT NULL DEFAULT 0 AFTER morning_tasks,
  ADD COLUMN IF NOT EXISTS afternoon_double tinyint(1) NOT NULL DEFAULT 0 AFTER afternoon_tasks;
