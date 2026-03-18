# Vibe Animation Competition — Technostav 2026

## Quick Start

```bash
npm install
npm start
```

Then open:
- Participant: http://localhost:3000
- Admin:       http://localhost:3000/admin  (token: technostav2026admin)

## Project Structure

```
├── server/
│   ├── server.js      # Express API
│   ├── judge.js       # Puppeteer + PixelMatch judge
│   └── database.js    # JSON file storage (no native modules)
├── public/
│   ├── index.html     # Participant interface
│   ├── main.js        # Participant JS
│   └── styles.css     # Styles
├── admin/
│   ├── admin.html     # Admin dashboard
│   ├── admin.js       # Admin JS
│   └── admin.css      # Admin styles
├── levels/
│   ├── level1-reference.html   # Pulsing Circle
│   ├── level2-reference.html   # Color Wave
│   ├── level3-reference.html   # Bouncing Ball
│   ├── level4-reference.html   # Rotating Galaxy
│   └── level5-reference.html   # Particle Burst
├── db.json            # Auto-created database
└── package.json
```

## Submission Rules
- HTML + CSS only
- No `<script>` tags
- No external URLs
- No `<canvas>`
- Need 50%+ accuracy to submit

## Admin Token
Default: `technostav2026admin`
Change: `set ADMIN_TOKEN=yourtoken && npm start`
