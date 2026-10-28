-- Gebruikers. De eerste gebruiker wordt automatisch beheerder en is direct actief;
-- alle volgende accounts staan op 'pending' tot een beheerder ze goedkeurt.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Inlogsessies voor de webinterface (token wordt alleen gehasht opgeslagen).
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- App-wachtwoorden voor CalDAV (Apple Agenda, DAVx⁵).
CREATE TABLE app_passwords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_app_passwords_user ON app_passwords(user_id);

-- Agenda's. sync_token loopt op bij elke wijziging (voor CalDAV-sync).
CREATE TABLE calendars (
  id          TEXT PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#2F6FED',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  sync_token  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_calendars_owner ON calendars(owner_id);

CREATE TABLE calendar_shares (
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_write   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (calendar_id, user_id)
);
CREATE INDEX idx_shares_user ON calendar_shares(user_id);

-- Afspraken. 'ics' is de bron van waarheid (zo blijft alles wat Apple/Samsung
-- meestuurt behouden); de overige kolommen zijn een index voor de webinterface.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  href        TEXT NOT NULL,
  uid         TEXT NOT NULL,
  ics         TEXT NOT NULL,
  etag        TEXT NOT NULL,
  summary     TEXT,
  first_start INTEGER,
  last_end    INTEGER,
  recurring   INTEGER NOT NULL DEFAULT 0,
  modseq      INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (calendar_id, href)
);
CREATE INDEX idx_events_range ON events(calendar_id, first_start, last_end);
CREATE INDEX idx_events_modseq ON events(calendar_id, modseq);

-- Verwijderde afspraken, zodat apparaten bij sync horen wat er weg is.
CREATE TABLE tombstones (
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  href        TEXT NOT NULL,
  modseq      INTEGER NOT NULL,
  PRIMARY KEY (calendar_id, href)
);

-- Eenvoudige rate limiting voor inloggen en registreren.
CREATE TABLE attempts (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX idx_attempts ON attempts(key, at);
