#!/usr/bin/env bash
# Met en service le code extrait dans ce dépôt (prod ou préprod).
#
# L'image est identifiée par l'arbre git du commit (stelleros:<arbre>), pas
# par le commit : une PR fusionnée en squash a un autre commit mais le même
# arbre que ce qui a tourné en préprod, et son image est alors réutilisée
# telle quelle au lieu d'être reconstruite. L'image est ensuite étiquetée
# stelleros:$APP_TAG (« prod », « preprod », lu dans le .env du projet) et
# chaque déploiement est noté dans deploiements.log, à côté du .env.
#
# Usage : app/deploy/deploie.sh (le dossier de projet est le parent du dépôt).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
project_dir=$(dirname "$repo")
# Images stelleros:<arbre> conservées pour les retours arrière.
keep=10

compose() { (cd "$project_dir" && docker compose "$@"); }

# Une modification locale d'un fichier versionné rendrait l'arbre mensonger.
if ! git -C "$repo" diff --quiet HEAD; then
  echo "Modifications locales dans $repo : abandon." >&2
  exit 1
fi

tree=$(git -C "$repo" rev-parse --short=12 'HEAD^{tree}')
commit=$(git -C "$repo" rev-parse --short=12 HEAD)
target=$(compose config --images | grep '^stelleros:')

if docker image inspect "stelleros:$tree" >/dev/null 2>&1; then
  echo "Image stelleros:$tree déjà construite : réutilisée."
  origin=reutilisee
else
  docker build -t "stelleros:$tree" "$repo"
  origin=construite
fi

docker tag "stelleros:$tree" "$target"
compose up -d
echo "$(date -u +%FT%TZ) $tree $commit $origin" >>"$project_dir/deploiements.log"
echo "$target = stelleros:$tree (commit $commit, image $origin)."

# Ménage : seules les $keep images d'arbre les plus récentes sont gardées.
# Une image encore étiquetée prod/preprod ne perd que son étiquette d'arbre.
docker images stelleros --format '{{.Tag}}' |
  grep -E '^[0-9a-f]{12}$' |
  tail -n +"$((keep + 1))" |
  while read -r old; do docker rmi "stelleros:$old" >/dev/null || true; done
