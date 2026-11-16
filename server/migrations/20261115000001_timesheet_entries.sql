-- Pointage des heures de travail : une ligne par utilisateur et par jour,
-- en deux demi-journées (matin, après-midi). Une demi-journée non travaillée
-- a ses deux heures à NULL. Les totaux sont calculés, jamais stockés.
--
-- Pas de clé étrangère vers auth_user : en production cette table existait
-- avant les migrations, avec une autre collation (utf8mb4_uca1400_ai_ci) que
-- celle de la migration auth (utf8mb4_general_ci). Une clé étrangère exige la
-- même collation des deux côtés : elle échouait en production. La collation
-- n'est pas fixée non plus : celle de la base s'applique.

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
  UNIQUE KEY uniq_user_date (user_id, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
