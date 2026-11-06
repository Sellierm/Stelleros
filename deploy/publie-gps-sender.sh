#!/usr/bin/env bash
# Publie une version de l'appli Android GPS Sender pour la mise à jour
# automatique des tablettes (routes /api/gps-sender/version et /apk).
#
# Usage : app/deploy/publie-gps-sender.sh [--force] <version | fichier.apk>
#         app/deploy/publie-gps-sender.sh --etat
#
#   2.3.0           télécharge app-release.apk de la release GitHub 2.3.0
#                   (publiée, pas en brouillon)
#   chemin/app.apk  publie un APK signé construit ailleurs (Android Studio)
#   --etat          affiche la version publiée
#
# Le dossier de projet est le parent du dépôt : le script de ~/stacks/site
# publie en prod, celui de ~/stacks/site-preprod en préprod. Le dossier
# gps-sender/ du projet est monté en lecture seule dans site-app : la
# publication prend effet tout de suite, sans redéploiement.
#
# Contrôles : paquet com.mathieu.gpssender, signature valide, versionCode
# supérieur à la version publiée, même certificat que la version publiée (une
# tablette refuse une mise à jour signée par une autre clé). --force lève les
# deux derniers contrôles.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
project_dir=$(dirname "$repo")
dest="$project_dir/gps-sender"
json="$dest/gps-sender.json"
github_repo=Sellierm/gps-sender
package=com.mathieu.gpssender
sdk_image=ghcr.io/cirruslabs/android-sdk:36

die() {
  echo "$*" >&2
  exit 1
}

force=0
case "${1:-}" in
  --etat)
    if [ -f "$json" ]; then jq . "$json"; else echo "Aucune version publiée dans $dest."; fi
    exit 0
    ;;
  --force)
    force=1
    shift
    ;;
esac
[ $# -eq 1 ] || die "Usage : $0 [--force] <version | fichier.apk> | --etat"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
apk="$work/app.apk"

if [ -f "$1" ]; then
  cp "$1" "$apk"
  source_desc=$(realpath "$1")
elif [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  url="https://github.com/$github_repo/releases/download/$1/app-release.apk"
  echo "Téléchargement de $url"
  curl -fsSL --retry 3 -o "$apk" "$url" ||
    die "APK introuvable : la release $1 est-elle publiée (pas en brouillon) ?"
  source_desc="release GitHub $1"
else
  die "« $1 » n'est ni un fichier ni un numéro de version (ex. 2.3.0)."
fi

# aapt2 et apksigner viennent de l'image du SDK Android (absent de l'hôte) ;
# apksigner échoue sur un APK non signé ou altéré.
infos=$(docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$work:/apk:ro" "$sdk_image" bash -c '
  bt=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n1)
  "$bt/aapt2" dump badging /apk/app.apk | head -n1
  "$bt/apksigner" verify --print-certs /apk/app.apk
' 2>"$work/sdk.err") || die "APK illisible ou signature invalide (APK non signé ?) : $(head -n1 "$work/sdk.err")"

badging=$(grep -m1 '^package:' <<<"$infos") || die "aapt2 n'a pas pu lire l'APK."
pkg=$(grep -oP " name='\K[^']+" <<<"$badging" | head -n1)
version_code=$(grep -oP "versionCode='\K[0-9]+" <<<"$badging" | head -n1)
version_name=$(grep -oP "versionName='\K[^']+" <<<"$badging" | head -n1)
signer=$(grep -m1 -oP '^Signer #1 certificate SHA-256 digest: \K[0-9a-f]+' <<<"$infos" || true)
signer_dn=$(grep -m1 -oP '^Signer #1 certificate DN: \K.*' <<<"$infos" || true)

[ "$pkg" = "$package" ] || die "Paquet « $pkg » : ce n'est pas GPS Sender ($package)."
[[ "$version_code" =~ ^[1-9][0-9]*$ ]] || die "versionCode illisible : « $version_code »."
[[ "$version_name" =~ ^[0-9A-Za-z._+-]{1,32}$ ]] || die "versionName refusé : « $version_name »."
[ -n "$signer" ] || die "Certificat de signature introuvable."
if [[ "$signer_dn" == *"Android Debug"* ]]; then
  echo "Attention : APK signé avec une clé de debug ($signer_dn)." >&2
fi

prev_file=
if [ -f "$json" ]; then
  prev_code=$(jq -r .versionCode "$json")
  prev_name=$(jq -r .versionName "$json")
  prev_signer=$(jq -r '.signer // ""' "$json")
  prev_file=$(jq -r .file "$json")
  if [ "$version_code" -le "$prev_code" ] && [ "$force" -eq 0 ]; then
    die "versionCode $version_code ($version_name) ≤ version publiée $prev_code ($prev_name) : \
les tablettes à jour ne l'installeraient pas. --force pour republier quand même."
  fi
  if [ -n "$prev_signer" ] && [ "$signer" != "$prev_signer" ] && [ "$force" -eq 0 ]; then
    die "Certificat différent de la version publiée ($signer_dn) : \
les tablettes refuseraient la mise à jour. --force pour publier quand même."
  fi
fi

mkdir -p "$dest"
file="gps-sender-$version_code.apk"
sha=$(sha256sum "$apk" | cut -d' ' -f1)
size=$(stat -c %s "$apk")

# L'APK d'abord, puis le JSON qui le désigne, chacun remplacé d'un bloc (mv) :
# le serveur ne voit jamais de fichier à moitié écrit.
install -m 644 "$apk" "$dest/.$file.tmp"
mv -f "$dest/.$file.tmp" "$dest/$file"
jq -n \
  --argjson versionCode "$version_code" --arg versionName "$version_name" \
  --arg file "$file" --arg sha256 "$sha" --argjson size "$size" \
  --arg signer "$signer" --arg signerDn "$signer_dn" \
  --arg source "$source_desc" --arg publishedAt "$(date -u +%FT%TZ)" \
  '{versionCode: $versionCode, versionName: $versionName, file: $file,
    sha256: $sha256, size: $size, signer: $signer, signerDn: $signerDn,
    source: $source, publishedAt: $publishedAt}' >"$dest/.gps-sender.json.tmp"
chmod 644 "$dest/.gps-sender.json.tmp"
mv -f "$dest/.gps-sender.json.tmp" "$json"

# On garde l'APK précédent : une tablette qui a lu l'ancien JSON juste avant
# la publication télécharge le nouveau, constate l'écart d'empreinte et
# réessaie plus tard.
for f in "$dest"/gps-sender-*.apk; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  [ "$name" = "$file" ] || [ "$name" = "$prev_file" ] || rm -f "$f"
done
echo "$(date -u +%FT%TZ) $version_name $version_code $sha $source_desc" >>"$dest/publications.log"

echo "Publié : GPS Sender $version_name (versionCode $version_code, $size octets)."
echo "Certificat : $signer_dn"
echo "  SHA-256 : $signer"
echo "Les tablettes l'installeront à leur prochaine vérification (démarrage de l'appli, puis toutes les 6 h)."
echo "Suivi : docker logs -f $(basename "$project_dir")-site-app-1 2>&1 | grep 'GPS Sender'"
