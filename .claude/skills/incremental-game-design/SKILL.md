---
name: incremental-game-design
description: Principes de game design pour Incrémental Factory (jeu incrémental/idle). À charger avant d'ajouter ou d'équilibrer une machine, une amélioration, une ressource, un jalon de déblocage, une étape, ou tout changement touchant la progression/l'équilibrage.
---

# Game design — Incrémental Factory

Jeu incrémental en 8 étapes (Minage → Fonderie → Usine → Logistique nationale → Logistique
internationale → Production spatiale → Colonisation → Expansion galactique), progression pilotée
par des coûts en croissance géométrique et des jalons de déblocage basés sur un débit de
production soutenu. Ces principes viennent des choix déjà faits dans le code — les respecter pour
rester cohérent avec l'existant, pas les réinventer par nouvelle fonctionnalité.

## Aucun achat sans effet

Chaque machine/amélioration payante doit modifier quelque chose d'atteignable dans l'état actuel
du jeu. Le projet a un précédent concret et coûteux : `fleet_s8`/`spd_s8`/`cap_s8`/`xfer_s8`
(section 2, ~ligne 537) pilotaient un transport inter-étapes qui n'existait pas à l'étape 8 (aucune
machine de l'étape 8 n'a d'entrée) — un joueur pouvait dépenser ~1,6 M de Science et 24 000 Fusées
sans aucun effet. Ils ont été supprimés en 0.4.0. **Avant d'ajouter un levier d'achat (`c:{...}`),
vérifier qu'il existe bien une recette, un chemin de transport ou un multiplicateur qui le
consomme.** Si une étape n'a délibérément pas de mécanique pour un type de levier (ex. pas de
transport à l'étape 8), ne pas créer ce levier pour cette étape.

## Croissance des coûts calibrée, pas devinée

Chaque machine a un facteur de croissance `g` (coût ×g par achat) et chaque jalon de déblocage
(`UNLOCK`) a un seuil de débit calibré "par simulation itérative (bot de référence, 6 clics/s)"
(voir commentaire ligne 448). Un nouveau contenu qui touche la progression doit être calibré de la
même façon — estimer le temps d'atteinte relatif aux paliers voisins plutôt que choisir un nombre
au hasard — et si un calcul de calibration a été fait, le documenter en commentaire comme pour les
seuils existants (temps approximatif en minutes, méthode utilisée).

## Révélation progressive

Une ressource ou un onglet n'apparaît que lorsqu'il devient pertinent (voir `REVEAL` et
`resVisible()`, section 6, et `seen{}`/`.tab.new` pour les onglets non encore visités). Ne pas
afficher une ressource ou une mécanique avant que le joueur ait un moyen d'agir dessus — ça crée de
la confusion sans intérêt de découverte.

## Jalons anti-triche, pas de reset sec

Le déblocage d'étape (`UNLOCK`) exige de **maintenir** un débit au-dessus d'un seuil pendant
`HOLD_NEEDED` secondes, mesuré en moyenne glissante (`AVG_WINDOW`) — un pic ponctuel ne suffit pas
à débloquer, et décrocher fait redescendre la barre progressivement plutôt que de tout remettre à
zéro (voir commentaire ligne 442-446). Tout nouveau système de jalon/objectif doit suivre le même
principe : mesure lissée dans le temps, dégradation progressive en cas d'échec, jamais un reset
brutal qui punit disproportionnellement une perte momentanée.

## Boucles de rétroaction : rester borné

La production globale (`cache.global`) compose plusieurs multiplicateurs (améliorations, recherche,
prestige, astro). Le laboratoire (seule machine sans recette d'entrée, purement multiplicative) est
délibérément exclu du multiplicateur `astro` (planètes/systèmes) pour éviter une boucle
science → astro → science non bornée (voir commentaire lignes 1104-1110 : sans cette exclusion,
32 ordres de grandeur en 38 minutes). **Avant d'introduire un nouveau multiplicateur global qui
pourrait s'appliquer à sa propre source de production, vérifier qu'il ne crée pas de boucle de
rétroaction positive non bornée**, et si une exclusion est nécessaire, la documenter comme ici.

## Arc narratif des étapes

Chaque étape (`STAGES[].desc`) a une identité thématique et mécanique propre : extraction manuelle
→ transformation → assemblage → réseau national → réseau international → rupture de paradigme
(passage en système multiplicatif à l'étape 6, signalé explicitement dans le texte) → colonisation
→ expansion galactique. Une nouvelle étape ou un nouveau système majeur doit avoir sa propre
identité (nouvelle mécanique de transport/production, pas juste des nombres plus gros) et un texte
`desc` qui explique au joueur ce qui change conceptuellement, dans le même ton (sobre, technique,
avec le vocabulaire industriel du jeu).

## Duplication vs. multiplicateurs de palier

Deux logiques de scaling coexistent et ne doivent pas être confondues : les machines "boost"
(`boost:{s,p}`, ex. `wagon`, `camion`, `train`) augmentent la cadence de l'étape **précédente**
multiplicativement par unité achetée (`(1+p)^n`), alors que l'accumulation d'une machine de
production bascule à un palier ×2 tous les `MILESTONE` (25) achats. Respecter cette distinction
pour toute nouvelle machine plutôt que d'inventer une troisième courbe.
