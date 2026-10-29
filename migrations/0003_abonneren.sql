-- Geheime abonneer-links (.ics) per agenda en gebruiker, voor Google Agenda, Outlook enz.
CREATE TABLE feeds (
  token       TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  UNIQUE (calendar_id, user_id)
);
