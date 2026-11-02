#!/usr/bin/env bash
# Arrête la préprod une heure après son dernier déploiement.
#
# La préprod ne sert qu'à valider une PR : passé DUREE_MAX secondes (1 h par
# défaut) depuis la dernière ligne de son deploiements.log (deploie.sh,
# retour-arriere.sh, copie-base-prod.sh), ses conteneurs (application, base,
# phpMyAdmin) sont arrêtés. Ils ne sont pas supprimés : la base est conservée
# et le prochain déploiement (job CI « Déploiement préprod », ou deploie.sh
# lancé dans ~/stacks/site-preprod/app) relance le tout pour une nouvelle heure.
# Un `docker compose start` ou un redémarrage du serveur ne compte pas comme un
# déploiement : la préprod est alors arrêtée à la minute suivante.
#
# Lancé chaque minute par la crontab de l'utilisateur server, depuis le dépôt
# de prod (toujours sur main ; celui de la préprod suit la PR déployée, qui
# peut ne pas contenir ce script) :
#   * * * * * f=$HOME/stacks/site/app/deploy/arret-preprod.sh; [ ! -f "$f" ] || bash "$f" >>"$HOME/stacks/site-preprod/arret-preprod.log" 2>&1
#
# Usage : deploy/arret-preprod.sh   (dossier : PREPROD_DIR, ~/stacks/site-preprod par défaut)
set -euo pipefail

preprod_dir=$(realpath "${PREPROD_DIR:-$HOME/stacks/site-preprod}")
duree_max=${DUREE_MAX:-3600}

# Garde-fou : ne jamais arrêter la prod.
if ! grep -qx 'APP_TAG=preprod' "$preprod_dir/.env"; then
  echo "$preprod_dir n'est pas la préprod (pas de APP_TAG=preprod dans .env) : abandon." >&2
  exit 1
fi

# Déploiement en cours (même verrou que deploie.sh, retour-arriere.sh et
# copie-base-prod.sh) : on repassera à la minute suivante.
exec 9>"$preprod_dir/.deploiement.lock"
flock -n 9 || exit 0

projet=$(basename "$preprod_dir")
if [ -z "$(docker ps -q --filter "label=com.docker.compose.project=$projet")" ]; then
  exit 0
fi

dernier=$(tail -n 1 "$preprod_dir/deploiements.log" 2>/dev/null | cut -d' ' -f1)
debut=$(date -d "${dernier:-@0}" +%s)
if [ $(($(date +%s) - debut)) -lt "$duree_max" ]; then
  exit 0
fi

(cd "$preprod_dir" && docker compose stop)
echo "$(date -u +%FT%TZ) préprod arrêtée (dernier déploiement : ${dernier:-aucun})."
