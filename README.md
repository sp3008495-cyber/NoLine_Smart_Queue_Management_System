# NoLine

**Smart queue management for hospital OPDs.**

We built this after looking at how OPD waiting rooms actually work in most hospitals: a paper token, a hope that your name gets called before the pharmacy shuts, and zero cell signal the moment you walk into the basement lab. So instead of building another app that assumes a perfect WiFi connection, we built one around the reality of a crowded hospital building.

## What it does

NoLine covers the whole trip through an OPD, not just the doctor's queue:

- Patients get a digital token in seconds, with a live wait-time estimate instead of a vague "please wait"
- Emergency cases and priority patients (seniors, PwD, pregnant patients) automatically move to the front
- Doctors see their queue pre-sorted by priority, and can mark themselves unavailable with a single tap — patients see it immediately
- When a doctor finishes a consultation, lab and pharmacy tokens are generated automatically, so nobody has to re-register at the next counter
- A public display board calls out tokens in both English and Hindi, with SMS as a backup
- A super-admin dashboard rolls all five branches up into one view, filterable by date

## The part we're proudest of

Hospital WiFi drops out constantly, and it's usually worst in the exact places patients need it — basement labs, pharmacy counters. So rather than pretend that away, we built an offline-capable digital token pass: a signed, tamper-evident QR code that gets cached on the patient's phone the second it's issued. It still opens and displays with zero signal. A front-desk kiosk verifies it against the server on *its own* connection, so the patient's phone never needs to talk to anything once the pass exists.

## Tech stack

- **Frontend** — plain HTML/CSS/JS, no build step, runs anywhere. Chart.js for the analytics.
- **Backend** — Node.js, Express, MySQL.
- **Auth & security** — JWT sessions, bcrypt password hashing, HMAC-SHA256 signed passes, a lightweight built-in rate limiter.
- **Notifications** — Twilio SMS, plus the Web Speech API for bilingual voice announcements.
- **Offline support** — a service worker and web app manifest, so the app (and the token pass specifically) keeps working after the first load, signal or not.

## Running it locally

```bash
git clone https://github.com/<your-username>/noline.git
cd noline
npm install
```

Create a `.env` file with your MySQL credentials, a JWT secret, a kiosk PIN, and (optionally) Twilio credentials.

Set up the database:

```bash
mysql -u root -p < schema.sql
node seed.js   # seeds 25 doctor accounts across the 5 branches
```

Start the server:

```bash
node server.js
```

Then open:
- `http://localhost:5000/index.html` — the patient & doctor app
- `http://localhost:5000/tv-display.html` — the public "now serving" board
- `http://localhost:5000/kiosk.html` — the front-desk pass scanner
- `http://localhost:5000/admin.html` — the multi-branch admin dashboard

## Team

Built by **Team Runtime Terrors**.
