-- Un point par (device_id, timestamp) dans gps_track, y compris sur une base
-- dont la table date d'avant la clé unique (ancien script manuel
-- server/schema/gps_track_unique.sql). Sans effet si c'est déjà le cas.
--
-- Le serveur insère avec INSERT IGNORE : un point renvoyé par la tablette
-- (ack perdu, lot rejoué après coupure) n'est enregistré qu'une fois.

-- 1. Supprime les doublons éventuels (garde la première ligne reçue).
DELETE t FROM gps_track t
JOIN gps_track d
  ON d.device_id = t.device_id
 AND d.timestamp = t.timestamp
 AND d.id < t.id;

-- 2. Remplace l'ancien index non unique par la clé unique.
ALTER TABLE gps_track
  DROP INDEX IF EXISTS idx_device_time,
  ADD UNIQUE KEY IF NOT EXISTS uq_device_time (device_id, timestamp);
