-- Bijhouden wie een afspraak toevoegt, wijzigt of verwijdert, zodat de app
-- meldingen kan geven als iemand anders iets in een gedeelde agenda verandert.
ALTER TABLE events ADD COLUMN created_at INTEGER;
ALTER TABLE events ADD COLUMN updated_by INTEGER;
ALTER TABLE tombstones ADD COLUMN summary TEXT;
ALTER TABLE tombstones ADD COLUMN deleted_by INTEGER;
ALTER TABLE tombstones ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_events_updated ON events(calendar_id, updated_at);
CREATE INDEX idx_tombstones_deleted ON tombstones(calendar_id, deleted_at);
