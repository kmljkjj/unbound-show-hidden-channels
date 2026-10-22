# ShowHiddenChannels (Unbound)

Affiche dans la liste des salons ceux auxquels tu n'as pas acces (restriction de role), avec un cadenas. La lecture des messages reste impossible : le serveur refuse de les envoyer. Le plugin ne modifie que l'affichage local du client ; il ne contourne aucune permission et ne bloque aucune action legitime.

## Installation (Unbound iOS)

1. Unbound > Plugins > ajouter un plugin depuis une URL
2. Coller : https://raw.githubusercontent.com/kmljkjj/unbound-show-hidden-channels/main/manifest.json
3. Activer le plugin, puis quitter completement Discord (force-quit) et le rouvrir

## Diagnostic

Au demarrage, un toast affiche : Actif v1.7.0 - N patches

- 11 patches : tout est operationnel.
- (manque: ...) : module CRITIQUE introuvable (can, canWithPartialContext, dispatch). Transmettre le toast exact pour adaptation.
- Les modules optionnels absents (messages, vocal, non-lus...) n'alertent pas dans le toast : voir dump().optionalMissing.

En cas de bug, copier le texte de unbound.__showHiddenChannels.formatDump() dans le rapport.

## Reglages (console Unbound : unbound.__showHiddenChannels)

- setSetting(nom, valeur) : modifie un reglage, confirme par un toast
- setSettings({...}) : modifie plusieurs reglages, retourne un rapport { changed, rejected, values } ; les valeurs de type incorrect sont refusees
- getSetting(nom) / getSettings() : lecture
- resetSettings() : restaure les valeurs par defaut
- getHiddenChannelIds() : ids des salons restreints connus
- refresh() : reconstruit la liste des salons
- dump() : diagnostic complet (version, patches, modules presents/absents, cache, erreurs, reglages)
- formatDump() : meme diagnostic en texte copiable pour les rapports de bug

Reglages disponibles (tous persistes dans le storage du plugin et recharges au demarrage) :

- Types affiches : showText, showVoice, showStage, showForum, showDirectory, showHiddenCategories, showThreads, showArchivedThreads, showPrivateThreads
- Comportement : markHidden (cadenas), blockUnreads (badges de non-lu a zero)
- Gardes : safety (maitre), preventNetworkRequests (fetchMessages/jumpToMessage), preventOpenAttempt (vocal/acknowledge), diagnosticToasts (toasts de blocage)
- Diagnostic : debug (journalisation console, desactive par defaut), cacheTtlMs (duree de validite du cache, 30000 ms par defaut)

## v1.7.0

Fiabilisation complete selon audit :

- Statut a trois etats ACCESSIBLE / RESTRICTED / UNKNOWN. En cas d'erreur de PermissionStore, de module absent ou de contexte incomplet, le statut est UNKNOWN : le plugin n'affiche pas le salon par defaut et ne bloque aucune action. L'inconnu est toujours neutre.
- Cache de permissions contextualise : cle userId:guildId:channelId, TTL (cacheTtlMs), limite 2000 entrees avec purge par anciennete, generation globale pour invalidation paresseuse, detection de changement de compte, statistiques dans dump().cache.
- Resolution Metro methode par methode : fetchMessages, jumpToMessage, joinVoiceChannel, selectVoiceChannel et acknowledge sont cherches independamment ; un module renomme ou scinde ne desactive plus les autres gardes. ChannelTypes et Permissions depuis les constantes avec replis numeriques.
- extractChannelId recursif : reconnait channelId, channel_id, channel, targetChannelId, valeurs primitives et tableaux, sur plusieurs signatures d'appel.
- isHidden : ajoute au prototype seulement s'il est absent, restauration EXACTE a l'arret (une implementation apparue entre-temps est preservee).
- Reconstruction coalessee : plusieurs invalidations successives declenchent une seule reconstruction ; emitChange du store en priorite, handlers internes en tout dernier recours.
- Collecte d'erreurs bornee (50 entrees, sans donnees sensibles) consultable via dump().errors ; mode debug desactive par defaut.
- Reglages valides par type, setSettings avec rapport changed/rejected, resetSettings, nouveaux filtres (categories, threads, threads archives, threads prives) et gardes parametrees.
- Toasts de blocage limites par cooldown (plus de spam pour un meme salon).
- Patches descriptifs { label, critical, unpatch, installedAt }, desinstallation en ordre inverse.

## v1.6.0

- Salon vocal restreint : joinVoiceChannel et selectVoiceChannel bloques proprement avec un toast explicatif, au lieu d'une erreur serveur 403.
- Marquer-comme-lu (acknowledge) bloque sur les salons restreints.
- Invalidation du cache etendue : suppression de role, suppression de serveur, threads, etc.
- Diagnostics a deux niveaux : le toast n'affiche que les manques critiques, les manques optionnels sont dans dump().optionalMissing.
- setSetting confirme par un toast ; getSetting(nom) ajoute au handle.

## v1.5.0

- can() sans aucun recalcul : le retournement VIEW_CHANNEL exploite directement le resultat du vrai can ; CONNECT et SEND_MESSAGES ne sont jamais modifies.
- Cache de permissions par salon, rempli passivement, invalide automatiquement (roles, salons, connexion).
- fetchMessages et jumpToMessage bloques vers les salons restreints.
- Badges de non-lu masques sur les salons restreints.
- Filtres par type, garde anti double-start, patches proteges, arret/redemarrage propres.

## Limites

- Les messages des salons restreints ne seront jamais lisibles (restriction cote serveur).
- Selon l'experiment private-channel-hiding, ouvrir un salon restreint peut afficher No Access.
- Les modules Metro (can, fetchMessages...) peuvent bouger avec les mises a jour de Discord : le toast de diagnostic liste ce qui manque.
- Les donnees de permissions ne sont stockees que localement, jamais envoyees.
