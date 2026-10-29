#!/usr/bin/env bash
# Remet en service une image déjà déployée, sans rien reconstruire.
#
# Usage : app/deploy/retour-arriere.sh            dernière image différente de celle en service
#         app/deploy/retour-arriere.sh <arbre>    image stelleros:<arbre> donnée
#         app/deploy/retour-arriere.sh --liste    déploiements et images dispo
#
# Le code du dépôt n'est pas modifié : le prochain déploiement (fusion sur
# main) remettra le code de main. Les migrations déjà appliquées restent en
# base, le serveur les tolère (cf. db::migrate).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
project_dir=$(dirname "$repo")
log="$project_dir/deploiements.log"

compose() { (cd "$project_dir" && docker compose "$@"); }

target=$(compose config --images | grep '^stelleros:')

if [ "${1:-}" = "--liste" ]; then
  echo "Derniers déploiements (date, arbre, commit, image) :"
  tail -n 10 "$log" 2>/dev/null || echo "  (aucun)"
  echo "Images disponibles :"
  docker images stelleros --format '  {{.Tag}}  {{.CreatedSince}}' | grep -E '^  [0-9a-f]{12} '
  exit 0
fi

current=$(docker image inspect --format '{{.Id}}' "$target")

if [ -n "${1:-}" ]; then
  tree=$1
else
  # Dernier arbre du journal dont l'image diffère de celle en service.
  tree=""
  while read -r _ t _; do
    id=$(docker image inspect --format '{{.Id}}' "stelleros:$t" 2>/dev/null) || continue
    if [ "$id" != "$current" ]; then tree=$t; break; fi
  done < <(tac "$log" 2>/dev/null)
  if [ -z "$tree" ]; then
    echo "Aucune image précédente disponible (voir --liste)." >&2
    exit 1
  fi
fi

if ! docker image inspect "stelleros:$tree" >/dev/null 2>&1; then
  echo "Image stelleros:$tree introuvable (voir --liste)." >&2
  exit 1
fi

docker tag "stelleros:$tree" "$target"
compose up -d
echo "$(date -u +%FT%TZ) $tree - retour-arriere" >>"$log"
echo "$target = stelleros:$tree (retour arrière)."
