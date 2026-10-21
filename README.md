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
5. Redémarre Discord si les salons n’apparaissent pas tout de suite

## Ce que fait le plugin

- Force l’affichage des salons sans permission `VIEW_CHANNEL`
- Bloque le chargement des messages (évite les erreurs 403)
- Bloque la navigation vers ces salons pour éviter un chat cassé

## Limites

- Si Discord active l’expérience serveur `private-channel-hiding`, les vrais noms peuvent apparaître comme **« No Access »** : le serveur ne les envoie plus. Aucun plugin client ne peut récupérer le vrai nom dans ce cas.
- Après une grosse update Discord, les modules internes (Metro) peuvent bouger et le plugin peut cesser de marcher jusqu’à une mise à jour.

## Désinstallation / crash

Unbound → **General** → **Recovery Mode**, redémarre, puis désactive ou supprime le plugin.

## Crédits

Logique inspirée des ports mobile Vendetta/Bunny (notamment c10udburst) et de l’approche Vencord ShowHiddenChannels.
