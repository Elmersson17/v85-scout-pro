# V85 Scout Pro

Travanalys-app som hämtar live-data från ATG:s API och presenterar odds, form, kusk/tränare-statistik och automatiska systemförslag.

---

## 🚀 Deploy till Netlify (steg för steg)

### Alternativ A – Via GitHub (rekommenderat)

1. **Skapa ett GitHub-repo**
   ```bash
   cd v85-scout-pro
   git init
   git add .
   git commit -m "V85 Scout Pro initial"
   ```

2. **Pusha till GitHub**
   - Gå till github.com → New repository → `v85-scout-pro`
   ```bash
   git remote add origin https://github.com/DITT-NAMN/v85-scout-pro.git
   git branch -M main
   git push -u origin main
   ```

3. **Koppla Netlify**
   - Gå till [app.netlify.com](https://app.netlify.com)
   - Klicka **"Add new site" → "Import an existing project"**
   - Välj **GitHub** → välj `v85-scout-pro`
   - Inställningar (ska fyllas i automatiskt från `netlify.toml`):
     - **Publish directory:** `.`
     - **Functions directory:** `netlify/functions`
   - Klicka **"Deploy site"**

4. **Klar!** Du får en URL typ `https://v85-scout-pro.netlify.app`

### Alternativ B – Manuell drag-and-drop

1. Kör `npm install` lokalt (skapar `node_modules/`)
2. Gå till [app.netlify.com](https://app.netlify.com)
3. Dra hela mappen `v85-scout-pro/` till Netlify's deploy-yta
4. Klar!

### Alternativ C – Netlify CLI

```bash
# Installera Netlify CLI
npm install -g netlify-cli

# Logga in
netlify login

# Skapa site & deploya
cd v85-scout-pro
npm install
netlify init
netlify deploy --prod
```

---

## 📁 Projektstruktur

```
v85-scout-pro/
├── index.html                  ← Frontend (allt i en fil)
├── netlify.toml                ← Config + redirects
├── package.json                ← Dependencies
├── .gitignore
├── README.md
└── netlify/
    └── functions/
        └── analyze.js          ← Serverless API → ATG
```

---

## 🔧 Hur det fungerar

1. **Frontend** (`index.html`) – komplett SPA i vanilla JS
   - Användaren klistrar in V85-ID (t.ex. `V85_2026-03-15_1`) eller ATG-länk
   - Anropar `/api/analyze?game=V85_2026-03-15_1`
   - Auto-uppdaterar var 60:e sekund

2. **Backend** (`netlify/functions/analyze.js`) – Netlify serverless function
   - Hämtar speldata från `atg.se/services/racinginfo/v1/api/games/{id}`
   - Hämtar varje lopp parallellt från `atg.se/services/racinginfo/v1/api/races/{id}`
   - Beräknar:
     - **Formsträngar** (V/P/U/D)
     - **Km-tider** + trend (förbättring/försämring)
     - **Value Score** (historisk vinstprocent vs implicerade odds)
     - **Front Runner Score** (spårposition + startmetod)
     - **Kusk/Tränare-form** (vinst% senaste 30 dagar)
     - **Scout-picks** (singel/gardering)
     - **Automatisk scout-analys** (textsammanfattning per lopp)
     - **Systemförslag** med budgetoptimering

3. **Redirects** (`netlify.toml`)
   - `/api/analyze` → `/.netlify/functions/analyze`

---

## 🔄 Live-uppdatering

Frontenden pollar automatiskt var 60:e sekund med samma game-ID.
Oddsen från ATG uppdateras i realtid, så varje poll ger fräscha odds + nya value scores.

---

## ⚙️ Anpassa

### Ändra uppdateringsintervall
I `index.html`, sök efter `60000` och ändra (i millisekunder):
```javascript
LT = setInterval(async () => { ... }, 60000); // 60 sek
```

### Lägga till fler speltyper
Funktionen stödjer redan V86 – ändra bara game-ID:t.

---

## 📝 ATG API-endpoints som används

| Endpoint | Beskrivning |
|----------|-------------|
| `GET /api/games/V85_{date}_{nr}` | Hämtar spelinfo med alla lopp-ID:n |
| `GET /api/races/{raceId}` | Hämtar detaljerad info per lopp (hästar, odds, resultat) |

Dessa är publika endpoints som ATG exponerar för sin egen frontend.
