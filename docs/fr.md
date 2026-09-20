# Xiaomi Home

Pilotez depuis Gladys les appareils Xiaomi, Mijia et Aqara de votre compte
Xiaomi Home : lampes, prises, capteurs, volets, climatiseurs, purificateurs,
aspirateurs robots… Tout passe par l'API cloud officielle utilisée par
l'intégration Xiaomi Home pour Home Assistant : rien à flasher, à rooter ni à
ré-appairer.

## Ce que vous obtenez

L'intégration lit la **spécification MIoT** de chaque appareil de votre compte
et la convertit en fonctionnalités Gladys — il n'y a aucune liste de modèles,
un appareil sorti demain fonctionne le jour même :

| Appareil Xiaomi                  | Ce qui apparaît dans Gladys                               |
| -------------------------------- | --------------------------------------------------------- |
| Ampoules, rubans, plafonniers    | Marche/arrêt, luminosité, température de couleur, couleur |
| Prises et interrupteurs          | Marche/arrêt, puissance, énergie, tension, courant        |
| Capteurs mouvement, porte, fuite | Capteurs binaires (mouvement, ouverture, fuite, fumée)    |
| Thermomètres, capteurs d'air     | Température, humidité, PM2.5, CO2, COV, pression          |
| Volets et rideaux                | Ouvrir/fermer/stop et position                            |
| Climatiseurs, radiateurs         | Marche/arrêt, mode, consigne, vitesse, oscillation        |
| Ventilateurs, purificateurs      | Marche/arrêt, vitesse, mode, usure du filtre              |
| Aspirateurs robots               | État, batterie, commandes démarrer/arrêter/charger        |
| Boutons et sonnettes             | Clic, double clic, appui long, sonnerie                   |

Ce que Gladys ne sait pas catégoriser (propriétés propriétaires) est exposé en
fonctionnalité texte : aucune information n'est perdue. Les actions sans
argument (démarrer le nettoyage, réinitialiser le filtre…) apparaissent comme
des interrupteurs de commande.

Les changements d'état arrivent **en temps réel** : l'intégration s'abonne au
canal push Xiaomi (MQTT). L'interrogation périodique reste le filet de
sécurité.

## Prérequis

- Un compte Xiaomi Home avec vos appareils déjà ajoutés dans l'application
  mobile Xiaomi Home (cette intégration n'appaire aucun appareil, elle pilote
  ceux que votre compte possède déjà).
- La **région** de ce compte : Chine, Europe, Inde, Russie, Singapour ou
  États-Unis. Les données sont cloisonnées par région — une mauvaise région
  affiche une liste d'appareils vide.
- Une connexion Internet : le pilotage passe par le cloud Xiaomi.

## Configuration

1. Installez l'intégration et ouvrez son onglet **Configuration**.
2. Choisissez votre **région Xiaomi** et enregistrez.
3. Cliquez sur **Connecter** à côté de « Compte Xiaomi » : un **QR code**
   s'ouvre dans un nouvel onglet.
4. Scannez-le avec votre téléphone — l'application **Xiaomi Home**
   (profil → scanner), la section **Compte Xiaomi** d'un téléphone Xiaomi, ou
   n'importe quelle appli photo — puis validez la connexion sur le téléphone.
5. C'est tout. Gladys termine la connexion tout seul, télécharge vos appareils
   et les publie. Ils apparaissent dans l'onglet **Découverte**, prêts à être
   ajoutés à votre tableau de bord.

Rien à copier, et votre navigateur n'est jamais envoyé vers une autre adresse.

**La page du QR code ne bouge pas après le scan — c'est normal.** C'est une
image statique chez Xiaomi, elle ne redirigera jamais nulle part. Ce qui bouge,
c'est l'indicateur de connexion de l'écran de configuration : il passe au vert
tout seul quelques secondes après votre validation sur le téléphone. S'il passe
au rouge, le message affiché dit exactement ce que Xiaomi a répondu.

### Si vous ne pouvez pas scanner le QR code

Xiaomi refuse de rediriger une connexion ailleurs que vers
`http://homeassistant.local:8123` — l'adresse enregistrée pour l'intégration
Home Assistant dont celle-ci dérive. Une adresse Gladys
(`http://gladysassistant.local`, une IP, autre chose) est refusée avec
_« invalid redirect uri »_, d'où le passage par le QR code. Le repli manuel
rejoue ce flux historique :

1. Lancez l'action **« Obtenir un lien de connexion manuel »** et ouvrez l'URL
   qu'elle renvoie.
2. Identifiez-vous et validez.
3. Xiaomi envoie votre navigateur vers `http://homeassistant.local:8123/…?code=…`,
   qui **ne se charge pas** — c'est normal, rien n'écoute à cette adresse.
4. Copiez l'adresse complète depuis la barre d'adresse.
5. Collez-la dans l'action **« Terminer la connexion »**.

Deux réglages optionnels :

- **Intervalle de rafraîchissement** — fréquence de relecture de chaque
  appareil dans le cloud, choisie dans une liste fixe (1 s à 1 minute ;
  1 minute par défaut — Gladys n'accepte que ces valeurs). Le canal push
  remonte déjà les changements instantanément ; ne le baissez que si un
  appareil ne pousse jamais son état.
- **Exposer toutes les propriétés** — crée aussi une fonctionnalité pour les
  propriétés propriétaires sans catégorie Gladys. Utile pour diagnostiquer un
  appareil exotique, bruyant sinon.

## Au quotidien

- **Rafraîchir la liste des appareils** — lancez cette action après avoir
  ajouté, renommé ou supprimé un appareil dans l'application Xiaomi Home.
- **Déconnecter le compte** — oublie les jetons stockés. À utiliser avant de
  relier un autre compte Xiaomi, ou pour révoquer cette instance Gladys.

La session se renouvelle toute seule : le jeton d'accès est rafraîchi avant son
expiration, sans action de votre part.

## Dépannage

**« Aucun appareil trouvé » après la connexion.** Le compte est presque
toujours rattaché à une autre région. Changez la région, enregistrez, puis
lancez « Rafraîchir la liste des appareils ».

**Le QR code a expiré.** Il est valable 5 minutes. Cliquez à nouveau sur
**Connecter** pour en obtenir un nouveau.

**Le QR code a été scanné mais rien ne se passe.** Validez la connexion sur le
téléphone (Xiaomi demande une confirmation après le scan) et vérifiez que la
région configurée correspond bien au compte. L'intégration signale l'échec
dans son état de connexion et dans les journaux.

**L'adresse collée est refusée.** Elle doit provenir de l'onglet où vous venez
de vous identifier et contenir `code=`. Si vous vous êtes identifié deux fois,
seule la dernière adresse est valable : un code ne s'échange qu'une fois.

**Un appareil manque.** Les appareils que l'API cloud Xiaomi ne sait pas
piloter sont ignorés : routeurs Xiaomi (`miwifi.*`), télécommandes infrarouges
(`chuangmi.ir.v2`) et quelques modèles que Xiaomi déclare lui-même non
supportés. Les appareils Bluetooth reliés à une passerelle fonctionnent tant
que la passerelle les remonte au cloud.

**Un appareil affiche le badge « injoignable ».** Xiaomi le signale hors
ligne. Vérifiez-le dans l'application Xiaomi Home : le problème vient de
l'appareil ou du réseau, pas de Gladys.

**« La session Xiaomi a expiré ».** Le jeton de rafraîchissement a été révoqué
(changement de mot de passe, déconnexion globale, autre client). Cliquez sur
Connecter et refaites la connexion.

**Lire les journaux.** L'intégration trace chaque appel. Passez la variable
d'environnement `LOG_LEVEL` à `debug` (ou lisez les logs de l'intégration dans
l'interface Gladys) pour voir la liste des appareils, les téléchargements de
spécifications et les commandes.
