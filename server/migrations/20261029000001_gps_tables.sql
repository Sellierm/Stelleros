-- Tables GPS (existantes en production : créées seulement si absentes).
-- La clé unique (device_id, timestamp) rend les renvois idempotents
-- (INSERT IGNORE côté serveur).

CREATE TABLE IF NOT EXISTS gps_track (
  id bigint(20) NOT NULL AUTO_INCREMENT,
  device_id varchar(20) NOT NULL,
  latitude double NOT NULL,
  longitude double NOT NULL,
  altitude double DEFAULT NULL,
  accuracy float DEFAULT NULL,
  speed float DEFAULT NULL,
  heading float DEFAULT NULL,
  source varchar(30) DEFAULT NULL,
  timestamp bigint(20) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_time (device_id, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gps_latest (
  device_id varchar(20) NOT NULL,
  latitude double NOT NULL,
  longitude double NOT NULL,
  altitude double DEFAULT NULL,
  accuracy float DEFAULT NULL,
  speed float DEFAULT NULL,
  heading float DEFAULT NULL,
  source varchar(30) DEFAULT NULL,
  timestamp bigint(20) NOT NULL,
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
