# Vibe Animation Competition — Technostav 2026

## Project Structure

```
project-root/
├── backend/          ← Deployed to Render
│   ├── server.js
│   ├── judge.js
│   ├── database.js
│   └── package.json
├── frontend/         ← Deployed to Vercel
│   ├── index.html
│   ├── styles.css
│   ├── main.js
│   ├── admin.html
│   ├── admin.css
│   └── admin.js
├── levels/           ← Reference animation HTMLs
│   ├── level1-reference.html
│   ├── level2-reference.html
│   ├── level3-reference.html
│   ├── level4-reference.html
│   └── level5-reference.html
├── db.json           ← Local dev database
├── render.yaml       ← Render deployment config
├── vercel.json       ← Vercel deployment config
└── .gitignore
```

## Quick Start (Local)

```bash
cd backend
npm install
npm start          # → http://localhost:3000
```

Set `BACKEND_URL` in `frontend/main.js` and `frontend/admin.js` to `http://localhost:3000` for local dev.

## Deployment

See the step-by-step guide below.
