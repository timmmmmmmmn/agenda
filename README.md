# Agenda · agenda.timvanbergen.nl

Eigen agenda op Cloudflare Workers (met statische bestanden) + D1, met een webinterface in Liquid Glass-stijl
en een CalDAV-server, zodat afspraken synchroniseren met Apple Agenda (Mac/iPhone)
en Samsung Agenda (via DAVx⁵).

## Wat zit waar

```
public/                 de webinterface (gewone HTML/CSS/JS, geen build-stap)
  index.html            de agenda (dag/week/maand)
  login.html            inloggen
  registreren.html      account aanmaken
  instellingen.html     profiel, apparaten koppelen, delen, gebruikersbeheer
  assets/               stijl en scripts
src/worker.js           ingang: stuurt /api, /dav en de rest (public/) door
functions/              serverkant
  api/[[path]].js       JSON-API voor de webinterface (/api/...)
  _lib/                 CalDAV-server, iCalendar, opslag, hulpfuncties
migrations/             databaseschema (D1)
wrangler.toml           Worker-config en koppeling met de D1-database
```

Elke push naar `main` wordt door Cloudflare automatisch gedeployed (`npx wrangler deploy`).

```
```

## Hoe het werkt

- **Accounts**: iedereen kan zich registreren. Het eerste account wordt beheerder
  en is direct actief; nieuwe accounts moet de beheerder goedkeuren
  (Instellingen › Gebruikers beheren).
- **Synchroniseren**: elk apparaat logt in met de gebruikersnaam en een eigen
  *app-wachtwoord* (aan te maken in Instellingen). Zo kun je een apparaat los
  intrekken.
- **Delen**: een agenda kun je delen met andere gebruikers, met of zonder
  bewerkrechten. Gedeelde agenda's verschijnen ook op hun apparaten.
- **Wachtwoord vergeten**: er is (nog) geen maildienst; de beheerder kan een
  tijdelijk wachtwoord maken.

## Apparaten koppelen

**Mac (Apple Agenda)**: Agenda › Instellingen › Accounts › + › Ander agenda-account ›
CalDAV-account › Handmatig. Server `agenda.timvanbergen.nl`, je gebruikersnaam en
een app-wachtwoord.

**Samsung**: installeer DAVx⁵, kies "Inloggen met URL en gebruikersnaam", URL
`https://agenda.timvanbergen.nl/dav/`, gebruikersnaam en app-wachtwoord. Vink de
agenda's aan; ze verschijnen in Samsung Agenda.

Nieuwe agenda's maak je in de webinterface (Cloudflare ondersteunt de
HTTP-methode MKCALENDAR niet, dus aanmaken vanaf de Mac lukt niet; afspraken
maken, wijzigen en verwijderen wel).

## Lokaal ontwikkelen

```sh
npx wrangler d1 migrations apply agenda-db --local
npx wrangler dev
```

Open daarna http://localhost:8787.

## Database bijwerken

Nieuwe migratie toevoegen in `migrations/` en uitvoeren met:

```sh
npx wrangler d1 migrations apply agenda-db --remote
```
