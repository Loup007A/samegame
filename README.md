# 🎮 SAME GAME

> Un site multijoueur où tout le monde croit jouer au même jeu — mais chaque joueur a une version unique générée procéduralement.

---

## Concept

Quand un joueur arrive sur le site, le serveur :
1. **Identifie** le joueur par son IP + fingerprint navigateur
2. **Génère** un jeu unique (seed aléatoire) parmi 4 types
3. **Assigne** une salle de chat (arcade / lounge / arena / tavern)
4. **Persiste** sa session : il retrouve toujours le même jeu en revenant

Les joueurs dans la même salle peuvent chatter — sans savoir que leurs jeux sont totalement différents.

---

## 4 types de mini-jeux

| Type | Description | Variables procédurales |
|------|-------------|----------------------|
| **Dodge** | Esquiver des obstacles tombants | Vitesse, forme obstacles, pattern background, gravité |
| **Breakout** | Casse-brique classique | Lignes/colonnes, vitesse balle, taille raquette, pattern briques, multiball |
| **Memory** | Retourner des paires de cartes | Grille 2×2 → 4×4, symboles (emoji/formes/lettres/chiffres), délai de flip |
| **Quiz** | QCM chronométré | Catégorie (maths/logique/anagramme/séquence), difficulté, nombre de questions |

Chaque jeu a aussi une **palette de couleurs unique** (6 palettes disponibles).

---

## Installation

```bash
# 1. Cloner / copier les fichiers
# Structure attendue :
# ├── server.js
# ├── package.json
# └── public/
#     └── index.html

# 2. Installer les dépendances
npm install

# 3. Lancer le serveur
node server.js
# → http://localhost:3000
```

---

## Architecture

```
server.js          — Backend Express + WebSocket + lowdb
public/index.html  — Frontend (vanilla JS, canvas games, chat WS)
db.json            — Base de données JSON (créée automatiquement)
```

### API REST

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/api/session` | POST | Créer/récupérer une session joueur |
| `/api/score` | POST | Mettre à jour le score |
| `/api/room/:room/scores` | GET | Leaderboard de la salle |
| `/api/room/:room/history` | GET | Historique du chat |

### WebSocket Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `join` | Client → Server | Rejoindre une salle |
| `chat` | Client ↔ Server | Message de chat |
| `score_update` | Client → Server | Broadcast du score |
| `online_count` | Server → Client | Nb joueurs en ligne |
| `system` | Server → Client | Messages système |

---

## Déploiement (production)

```bash
# Avec PM2
npm install -g pm2
pm2 start server.js --name same-game
pm2 save

# Avec variables d'environnement
PORT=8080 node server.js
```

### Nginx (reverse proxy)

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";  # Important pour WebSocket
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

---

## Personnalisation

### Ajouter un nouveau type de jeu

1. Dans `server.js`, ajouter le type dans `GAME_TYPES` et `configs` de `generateGameConfig()`
2. Dans `public/index.html`, ajouter une fonction `initMonJeu(canvas, ctx)` et l'appeler dans `initGame()`

### Ajouter une palette de couleurs

Dans `generateGameConfig()`, ajouter un objet `{ bg, primary, secondary, accent }` au tableau `palettes`.

### Modifier la logique d'assignation des salles

Par défaut : aléatoire. Tu peux remplacer par une logique basée sur l'heure, la géolocalisation, le hash de l'IP, etc.

---

## Ce que les joueurs NE savent pas

- Que leur jeu est différent de celui du voisin
- Que les "scores" dans le leaderboard viennent de jeux complètement différents
- Que quand ils demandent "t'as passé quel niveau ?" dans le chat, personne ne joue au même jeu
