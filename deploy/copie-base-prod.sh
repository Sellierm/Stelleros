#!/usr/bin/env bash
# Remplace la base de la préprod par une copie de la base de prod.
#
# La prod n'est que lue (mariadb-dump --single-transaction, sans verrou).
# L'application de préprod est arrêtée pendant l'import puis redéployée par
# deploie.sh (image déjà construite, réutilisée) : ses migrations sqlx
# s'appliquent alors sur la copie, ce qui les teste sur de vraies données
# avant qu'elles n'atteignent la prod. La copie compte comme un déploiement :
# la préprod repart pour une heure (arret-preprod.sh), même si elle était
# arrêtée.
#
# Usage : deploy/copie-base-prod.sh
# Dossiers (projets Compose) : PROD_DIR (~/stacks/site), PREPROD_DIR (~/stacks/site-preprod).
set -euo pipefail

prod_dir=$(realpath "${PROD_DIR:-$HOME/stacks/site}")
preprod_dir=$(realpath "${PREPROD_DIR:-$HOME/stacks/site-preprod}")

if [ "$prod_dir" = "$preprod_dir" ]; then
  echo "PROD_DIR et PREPROD_DIR désignent le même dossier : abandon." >&2
  exit 1
fi

prod() { (cd "$prod_dir" && docker compose "$@"); }
preprod() { (cd "$preprod_dir" && docker compose "$@"); }

# Pendant la copie, arret-preprod.sh ne doit pas arrêter la base de préprod.
exec 9>"$preprod_dir/.deploiement.lock"
flock 9

# La préprod a pu être arrêtée par arret-preprod.sh.
preprod up -d --wait site-db

# Garde-fou : la cible ne doit pas être le conteneur de base de la prod.
if [ "$(prod ps -q site-db)" = "$(preprod ps -q site-db)" ]; then
  echo "La base de préprod est celle de la prod : abandon." >&2
  exit 1
fi

echo "Arrêt de l'application de préprod…"
preprod stop site-app

echo "Recréation de la base de préprod…"
preprod exec -T site-db sh -c '
  MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot \
    -e "DROP DATABASE IF EXISTS \`$MARIADB_DATABASE\`; CREATE DATABASE \`$MARIADB_DATABASE\`"'

echo "Copie prod → préprod…"
prod exec -T site-db sh -c '
  MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot \
    --single-transaction --routines --triggers --events "$MARIADB_DATABASE"' |
  preprod exec -T site-db sh -c '
    MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot "$MARIADB_DATABASE"'

# deploie.sh prend lui-même le verrou : on le libère avant.
exec 9>&-
echo "Redéploiement de la préprod…"
"$preprod_dir/app/deploy/deploie.sh"
echo "Terminé."
