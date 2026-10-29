-- Historique : lecture d'une journée par plage de timestamps (tous engins),
-- liste des jours disponibles et suivi de la compaction quotidienne.

CREATE INDEX IF NOT EXISTS idx_timestamp ON gps_track (timestamp);

-- Jours calendaires (heure de Paris) ayant des positions, par engin.
CREATE TABLE IF NOT EXISTS gps_days (
  day date NOT NULL,
  device_id varchar(20) NOT NULL,
  PRIMARY KEY (day, device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Jours déjà compactés (une compaction ne repasse jamais sur un jour).
CREATE TABLE IF NOT EXISTS gps_compaction (
  day date NOT NULL,
  device_id varchar(20) NOT NULL,
  points_before int NOT NULL,
  points_after int NOT NULL,
  compacted_at datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (day, device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
