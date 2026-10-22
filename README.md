# ShowHiddenChannels (Unbound)

Affiche dans la liste des salons ceux auxquels tu n'as pas acces (restriction de role), avec un cadenas. La lecture des messages reste impossible : le serveur refuse de les envoyer.

## Installation (Unbound iOS)

1. Unbound > Plugins > ajouter un plugin depuis une URL
2. Coller : https://raw.githubusercontent.com/kmljkjj/unbound-show-hidden-channels/main/manifest.json
3. Activer le plugin, puis quitter completement Discord (force-quit) et le rouvrir

## Diagnostic

Au demarrage, un toast affiche : Actif v1.5.0 - N patches

- 8 patches : tout est operationnel.
- (manque: ...) : certains modules Discord n'ont pas ete trouves. Transmettre le toast exact pour adaptation.

## Reglages (console Unbound : unbound.__showHiddenChannels)

- setSetting(nom, boolean) : showText, showVoice, showStage, showForum, showDirectory (types de salons affiches), markHidden, blockUnreads, safety
- getSettings() : reglages courants
- getHiddenChannelIds() : ids des salons restreints connus
- refresh() : reconstruit la liste des salons
- dump() : diagnostic complet (version, patches, manquants, reglages)

Tous les reglages sont persistes dans le storage du plugin et recharges au demarrage.

## v1.5.0

- can() sans aucun recalcul : le retournement VIEW_CHANNEL exploite directement le resultat du vrai can ; CONNECT et SEND_MESSAGES ne sont jamais modifies.
- Cache de permissions par salon, rempli passivement, invalide automatiquement sur GUILD_ROLE_UPDATE, CHANNEL_UPDATE, CONNECTION_OPEN, etc.
- fetchMessages et jumpToMessage bloques vers les salons restreints (evite les erreurs serveur).
- Badges de non-lu masques sur les salons restreints.
- Filtres par type, garde anti double-start, patches proteges, arret/redemarrage propres.

## Limites

- Les messages des salons restreints ne seront jamais lisibles (restriction cote serveur).
- Selon l'experiment private-channel-hiding, ouvrir un salon restreint peut afficher No Access.
- Les modules Metro (can, fetchMessages...) peuvent bouger avec les mises a jour de Discord : le toast de diagnostic liste ce qui manque.
