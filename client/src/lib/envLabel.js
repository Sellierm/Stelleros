// Libellé d'environnement (« PRÉPROD ») fourni par le serveur (ENV_LABEL) :
// il n'est pas intégré au build, pour que la même image serve en préprod puis
// en prod.

let envLabel = null;

/** Préfixe un titre d'onglet avec le libellé d'environnement, s'il y en a un. */
export function withEnvLabel(title) {
  return envLabel ? `[${envLabel}] ${title}` : title;
}

/** Lit le libellé, affiche le bandeau et préfixe le titre déjà en place. */
export async function loadEnvLabel() {
  try {
    const res = await fetch("/api/env");
    if (!res.ok) return;
    const { label } = await res.json();
    if (!label) return;
    envLabel = label;
    document.title = withEnvLabel(document.title);

    const banner = document.createElement("div");
    banner.className = "env-banner";
    banner.textContent = label;
    document.body.appendChild(banner);
  } catch {
    // Pas de libellé : pas de bandeau (cas de la prod).
  }
}
