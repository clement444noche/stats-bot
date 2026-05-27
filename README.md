# 📊 Bot Discord — Stats GAML

Bot Discord qui affiche les statistiques de clics GetAllMyLinks à chaque VA.

---

## 🚀 Installation rapide

### 1. Crée ton bot Discord

1. Va sur https://discord.com/developers/applications
2. **New Application** → donne-lui un nom
3. Onglet **Bot** → **Reset Token** → copie le token
4. Onglet **OAuth2 > URL Generator** :
   - Scopes : `bot`
   - Bot permissions : `Send Messages`, `Read Messages/View Channels`, `Embed Links`, `Read Message History`
5. Copie l'URL générée et ouvre-la pour inviter le bot sur ton serveur

### 2. Configure les variables d'environnement

```bash
cp .env.example .env
```

Remplis `.env` avec :
- `DISCORD_TOKEN` → ton token bot
- `GAML_API_KEY` → ta clé API GetAllMyLinks (`gaml_xxx...`)
- `CHANNEL_ID` → l'ID du salon (optionnel, juste pour référence)

### 3. Configure tes VAs

Édite `vas.json` :

```json
{
  "123456789012345678": {
    "name": "Sarah",
    "linkId": "uuid-du-lien-gaml"
  },
  "987654321098765432": {
    "name": "Lucas",
    "linkId": "uuid-du-lien-gaml"
  }
}
```

> **Comment trouver l'ID Discord d'une VA ?**
> Active le mode développeur dans Discord (Paramètres → Avancé → Mode développeur),
> puis clic droit sur le pseudo → "Copier l'identifiant".

> **Comment trouver le link_id GAML ?**
> Dans ton dashboard GetAllMyLinks, va sur le lien de ta VA.
> L'UUID se trouve dans l'URL ou dans les détails du lien.

### 4. Ajuste les paramètres métier

Dans `config.js` :
- `cycle.startDate` → date de début du 1er cycle
- `cycle.cycleDays` → durée du cycle (défaut : 14 jours)
- `payment.thresholdClicks` → seuil de clics pour débloquer le paiement
- `payment.amountOnThreshold` → montant en $ débloqué

### 5. Lance le bot

**En local :**
```bash
npm install
npm start
```

**Sur Railway (recommandé) :**
1. Crée un compte sur https://railway.app
2. **New Project → Deploy from GitHub Repo** (upload ton dossier)
3. Dans les variables d'environnement Railway, ajoute `DISCORD_TOKEN` et `GAML_API_KEY`
4. Deploy !

---

## 🎮 Utilisation

### Setup initial (une seule fois)
Dans le salon Discord où tu veux que le bouton apparaisse, tape :
```
!setup
```
→ Le bot postera le message avec le bouton "Consulter mes clics".

### Les VAs
Chaque VA clique sur le bouton → voit ses stats en message éphémère (visible que par eux).

Boutons disponibles :
| Bouton | Période |
|--------|---------|
| **Cycle** | Cycle en cours (ex: 2 semaines) |
| **Aujourd'hui** | Jour actuel |
| **Hier** | Jour précédent |
| **7 jours** | 7 derniers jours |
| **14 jours** | 14 derniers jours |
| **📩 Envoyer en DM** | Envoie les stats du cycle en DM |

---

## 🛠 Ajouter / modifier une VA

Édite simplement `vas.json` — pas besoin de redémarrer le bot.

---

## 📌 Pays Tier-1 (bons clics)

Par défaut : US, CA, GB, AU, NZ, FR, DE, IT, ES, NL, BE, CH, AT, PT, IE, LU, DK, SE, NO, FI, JP, SG, HK

Modifiable dans `config.js` → `tier1Countries`.
