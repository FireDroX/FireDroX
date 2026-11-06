# Rendu du profil cyberpunk

Le README du profil n'affiche que des images. Elles sont produites par
`render.mjs` : `template.html` + `profile.json` + données GitHub → une capture
Playwright (Chromium) par bloc → PNG compressés avec sharp.

Le workflow `.github/workflows/profile.yml` le lance chaque matin, sur
`workflow_dispatch` et à chaque push sur `main` qui touche `profile/**`. Les PNG
sont force-poussés (un seul commit) sur la branche `output`, jamais sur `main`.

## Lancer le rendu en local

```bash
cd profile
npm ci && npx playwright install chromium && node render.mjs
```

Les images arrivent dans `profile/out/` (plus `full.png`, aperçu pleine page, et
`index.html`, la page rendue, à ouvrir dans un navigateur).

Variables utiles :

| Variable | Rôle |
| --- | --- |
| `GITHUB_TOKEN` ou `PROFILE_TOKEN` | jeton pour la grille de contributions réelle (sinon grille d'exemple) |
| `GITFUT_FILE` | PNG GitFut local (sinon téléchargé depuis la branche `gitfut`) |
| `CONTRIBUTIONS_FILE` | réponse GraphQL en JSON, pour travailler hors ligne |
| `CHROMIUM_PATH` | Chromium déjà installé à utiliser à la place de celui de Playwright |

Une source indisponible (API, GitFut, logo) ne casse pas le rendu : le bloc garde
le placeholder de la maquette et un `::warning::` apparaît dans les logs. Seules
les polices sont obligatoires : sans elles, le build échoue.

## Modifier le contenu

Tout le texte est dans **`profile.json`** : titre, rôles, lignes « À propos »,
groupes de la stack, projets, liens. `**gras**` et `` `code` `` sont reconnus
dans les textes. Le HTML (`template.html`) ne contient aucun texte.

Le README référence les images par leur nom, avec un paramètre `?v=` calculé à
partir de `profile.json` et du template. Après une modification de contenu :

```bash
cd profile
node render.mjs --readme
```

puis committer `profile.json` **et** `README.md`. Le workflow avertit si le
README n'est plus synchronisé. Les données quotidiennes (contributions, GitFut,
date) ne changent pas le README : les images sont simplement remplacées sur
`output` (cache de `raw.githubusercontent.com` : 5 minutes).

### Ajouter un projet

Ajouter une entrée dans `projects` :

```json
{
  "slug": "mon-projet",
  "title": "Mon **Projet**",
  "repo": "FireDroX/mon-projet",
  "description": "Une phrase de présentation.",
  "features": ["Point clé", "Autre point avec `code`"],
  "tags": ["React", "Node.js"]
}
```

- `slug` : `a-z`, `0-9`, `-` ; il donne le fichier `project-<slug>.png`.
- La partie en `**gras**` du titre prend la couleur d'accent.
- Les bordures alternent cyan / jaune ; avec un nombre impair de projets, le
  dernier prend toute la largeur.

Puis `node render.mjs --readme` et committer.

## Compter les contributions privées (`PROFILE_TOKEN`)

Le workflow lit le calendrier avec `GITHUB_TOKEN`, c'est-à-dire en visiteur
anonyme : il voit exactement la grille publique du profil.

**Option simple (aucun jeton)** : dans GitHub, *Settings → Public profile →
Contributions & activity*, cocher **Include private contributions on my
profile**. Les contributions privées apparaissent alors (anonymisées) dans la
grille publique, donc aussi dans le rendu.

**Option jeton** (pour les compter sans les afficher sur le profil public) :

1. *Settings → Developer settings → Personal access tokens → Tokens (classic) →
   Generate new token (classic)*.
2. Scope minimal : **`read:user`** uniquement. Expiration : la plus longue
   acceptable, à renouveler ensuite.
3. Dans ce dépôt : *Settings → Secrets and variables → Actions → New repository
   secret*, nom **`PROFILE_TOKEN`**, valeur = le jeton.

Le workflow l'utilise automatiquement s'il existe, sinon il retombe sur
`GITHUB_TOKEN`. Le total affiché sous la grille dans les logs
(`contributions : N sur 53 semaines`) permet de vérifier la différence.
