# ShowHiddenChannels (Unbound)

Affiche les **salons cachés** (restriction de rôle) dans la liste des salons Discord mobile via Unbound.

Tu vois le **nom**, le **topic** et le salon dans la sidebar.  
Tu **ne peux pas** lire les messages : Discord ne les envoie jamais au client (impossible).

## Installation

1. Discord → **Paramètres** → **Unbound** → **Plugins**
2. Appuie sur **+**
3. Colle ce lien :

```
https://raw.githubusercontent.com/kmljkjj/unbound-show-hidden-channels/main/manifest.json
```

4. **Install** → active le switch

## Correctif v1.4.0 (important)

Les versions ≤ 1.3.0 **ne démarraient jamais** : le fichier était en CommonJS (`require` / `module.exports`), alors qu'Unbound évalue le bundle avec :

```js
const iife = eval(`(() => { return ${bundle} })`);
const instance = typeof iife() === 'function' ? iife()() : iife();
return instance?.default ?? instance;
```

Un bundle qui n'est pas **une seule expression retournant l'objet du plugin** fait retourner `undefined` au loader : `start()` n'est jamais appelé, aucun toast, aucun effet. C'est pourquoi le toast v1.3.0 ne s'affichait pas.

La v1.4.0 est un IIFE qui retourne `{ start, stop }` et utilise le global `unbound` (`metro`, `patcher`, `toasts`), comme les bundles produits par le template rollup officiel d'Unbound.

## Ce que fait le plugin

- `PermissionStore.can` / `canWithPartialContext` : `VIEW_CHANNEL` → `true`, `CONNECT` → `false`, **uniquement** pour les salons réellement refusés (vérifiés via le vrai `can` capturé avant le patch)
- `ChannelRecordBase.prototype.isHidden` : ajouté seulement s'il manque (même approche que le port tharkidetta)
- Blocage de `fetchMessages` sur les salons restreints (évite les erreurs serveur)
- `UnreadStore` : pas de badges de non-lu sur les salons cachés
- Reset de `PermissionStore` + `ChannelListStore` via le Dispatcher Flux pour reconstruire la liste

## Limites

- Si Discord active l'expérience serveur `private-channel-hiding`, les vrais noms peuvent apparaître comme **« No Access »** : le serveur ne les envoie plus. Passer l'expérience en **Not Eligible** (via un plugin Experiments), puis **forcer la fermeture de l'app et se reconnecter** (le simple restart d'Unbound ne suffit pas toujours, le cache client peut persister).
- Après une grosse update Discord, les modules internes (Metro) peuvent bouger et le plugin peut cesser de marcher jusqu'à une mise à jour.

## Diagnostic

Au switch ON, un toast doit apparaître :

- « Actif v1.4.0… » → plugin OK
- « ERREUR: API Unbound introuvable » → problème d'accès au global `unbound`
- « ERREUR: PermissionStore (can) introuvable » → modules Discord à retrouver (update Discord)
- Aucun toast → le plugin ne démarre pas (carte en erreur rouge ? version < 1.4.0 encore installée ?)

## Désinstallation / crash

Unbound → **General** → **Recovery Mode**, redémarre, puis désactive ou supprime le plugin.

## Crédits

Logique portée des versions mobiles : Lioncat6 (revenge), c10udburst (vendetta), yofukashino (tharkidetta / ShowHiddenChannels).
