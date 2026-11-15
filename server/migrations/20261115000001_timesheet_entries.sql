-- Pointage des heures de travail : une ligne par utilisateur et par jour,
-- en deux demi-journées (matin, après-midi). Une demi-journée non travaillée
-- a ses deux heures à NULL. Les totaux sont calculés, jamais stockés.

CREATE TABLE IF NOT EXISTS timesheet_entries (
  id int(11) NOT NULL AUTO_INCREMENT,
  user_id varchar(36) NOT NULL,
  date date NOT NULL,
  morning_start time DEFAULT NULL,
  morning_end time DEFAULT NULL,
  morning_tasks text DEFAULT NULL,
  afternoon_start time DEFAULT NULL,
  afternoon_end time DEFAULT NULL,
  afternoon_tasks text DEFAULT NULL,
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_date (user_id, date),
  CONSTRAINT fk_timesheet_user FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
