-- Un point par (device_id, timestamp) dans gps_track.
--
-- Le serveur insère avec INSERT IGNORE : un point renvoyé par la tablette
-- (ack perdu, lot rejoué après coupure) n'est plus enregistré deux fois.
-- La clé unique remplace l'index idx_device_time sur les mêmes colonnes.

-- 1. Supprime les doublons existants (garde la première ligne reçue).
DELETE t FROM gps_track t
JOIN gps_track d
  ON d.device_id = t.device_id
 AND d.timestamp = t.timestamp
 AND d.id < t.id;

-- 2. Remplace l'index par une clé unique.
ALTER TABLE gps_track
  DROP INDEX idx_device_time,
  ADD UNIQUE KEY uq_device_time (device_id, timestamp);
