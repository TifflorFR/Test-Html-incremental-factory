---
name: vanilla-js-game-code
description: Conventions de code pour Incrémental Factory — jeu vanilla JS/CSS/HTML monofichier sans build. À charger avant toute modification de index.html ou recherche.html (nouvelle machine, amélioration, ressource, refonte d'une section, changement de rendu).
---

# Conventions de code — Incrémental Factory

Ce projet est un jeu incrémental en **un seul fichier HTML** (`index.html`, ~160 Ko : CSS + JS
inline dans une seule balise `<script>`) plus `recherche.html` pour l'arbre de recherche, ouvert
en `<iframe>` overlay. Aucun build, aucun bundler, aucune dépendance externe. Ces contraintes sont
volontaires : le jeu reste jouable en ouvrant le fichier directement dans un navigateur.

## Ne pas introduire

- Pas de framework (React, Vue…), pas de bundler (Vite, Webpack…), pas de gestionnaire de paquets.
- Ne pas éclater `index.html` en plusieurs fichiers JS/CSS sauf demande explicite de l'utilisateur
  — le monofichier est un choix assumé, pas un oubli.
- Pas de dépendances CDN : tout doit continuer à fonctionner hors ligne, fichier ouvert en local.

## Organisation en sections numérotées

Le script est structuré par des en-têtes de section commentés :

```
/* ==========================================================================
   N. TITRE DE LA SECTION
   ========================================================================== */
```

(1. Utilitaires, 2. Données, 2 bis. Transport, 3. État, 4. Moteur, 5. Prestige, 6. Interface,
7. Sauvegarde, 8. Contrôles, 9. Boucle — plus des blocs non numérotés comme Énergie, Arbre de
recherche, Oléoduc, Pop-ups, Galaxie). Toute nouvelle fonction ou donnée va dans la section qui
correspond à son rôle ; ne pas créer une nouvelle section pour une fonctionnalité qui rentre déjà
dans une catégorie existante.

## Données déclaratives, moteur générique

`RES`, `STAGES`, `MACH`, `UP`, `PLANETS`, `CLICKABLE` (section 2) décrivent tout le contenu du jeu
sous forme d'objets/tableaux plats. Le moteur (`recompute()`, `cost()`, `afford()`, `pay()`,
`bulkCost()`, `maxBuy()`, `mMult()`…) lit ces données génériquement — il n'y a jamais de `if(id===
'bucheron')` dans la logique de calcul. **Pour ajouter une machine/amélioration/ressource, on
ajoute une entrée dans le tableau correspondant ; on ne bifurque pas le moteur par identifiant.**
Si un nouveau type d'effet est nécessaire, l'ajouter comme clé générique dans l'objet `e:{}` (voir
`click`, `auto`, `mult`, `stage`, `global`, `colon`) et le brancher dans `recompute()`, pas en
dur ailleurs.

## Commentaires

Comme partout dans ce fichier : uniquement pour expliquer un **pourquoi** non évident (contrainte
cachée, calcul de calibration, compromis, bug contourné) — jamais pour paraphraser le code. Rédigés
en français, dans le style déjà en place (ex. lignes 442-457 sur les jalons, 1104-1110 sur
`c.astro`). Un commentaire qui ne resterait pas utile après relecture par quelqu'un d'autre ne doit
pas être écrit.

## Versioning

`GAME_VERSION` (const en tête de section 3) suit MAJOR.MINOR.PATCH : MINOR pour toute nouvelle
fonctionnalité, PATCH pour un correctif/réglage isolé. À incrémenter à **chaque** livraison,
jamais rétroactivement (voir le commentaire juste au-dessus de la constante). Ne pas oublier de
la faire évoluer quand une modification est livrée.

## Rendu / performance

- Les nœuds DOM fréquemment mis à jour sont mis en cache dans `refs` plutôt que re-requêtés à
  chaque frame (`document.querySelector` coûte cher en boucle).
- Le flag `structuralDirty` évite de reconstruire tout le DOM (onglets, barre de ressources…)
  quand seule une valeur change — ne rebâtir le HTML complet que quand la structure change
  réellement (nouvel onglet débloqué, ressource révélée, etc.), sinon mettre à jour les nœuds
  ciblés via leurs `data-*`.
- Le HTML généré dynamiquement passe par `array.map(...).join('')` assigné à `.innerHTML` — rester
  cohérent avec ce style plutôt que construire le DOM impérativement nœud par nœud.

## Ne jamais laisser du code mort silencieux

Si un mécanisme est retiré ou désactivé, soit on le supprime entièrement, soit on documente
explicitement pourquoi avec un commentaire daté (voir l'exemple lignes 537-541 : suppression des
leviers `fleet_s8`/`spd_s8`/`cap_s8`/`xfer_s8` en 0.4.0, avec l'explication du bug qu'ils
représentaient). Un levier d'achat qui ne produit aucun effet est un bug de conception, pas un
détail cosmétique — voir la skill `incremental-game-design` à ce sujet.

## Sauvegarde

La compatibilité ascendante des sauvegardes est un souci constant (voir section 7 et les
migrations comme `labLvlTarget===undefined` en 2465). Toute nouvelle clé de `state` doit avoir une
valeur par défaut sûre pour les sauvegardes existantes qui ne la contiennent pas.

## Test

Pas de suite de tests automatisés. Valider manuellement dans un navigateur : ouvrir `index.html`,
vérifier l'étape modifiée (et les étapes voisines si l'équilibrage global est touché), tester un
cycle sauvegarde → rechargement → chargement pour toute modification de `state` ou `freshState()`.

## Git

Le dépôt est synchronisé avec `origin/main` sur GitHub et est aussi édité en parallèle hors Claude
Code (upload manuel). Toujours `git pull` avant de commencer une session de travail, et
`git commit` + `git push` après une modification livrée, pour rester cohérent avec l'autre canal
de travail.
