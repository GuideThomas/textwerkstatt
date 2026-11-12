-- Sitzungen in Postgres statt im Arbeitsspeicher (18.09.2026).
-- Mit dem MemoryStore meldete jeder Deploy und jeder pm2-Neustart alle ab —
-- auch Native Speaker mitten im Review. Schema wie von connect-pg-simple
-- erwartet (node_modules/connect-pg-simple/table.sql), hier idempotent,
-- weil migrate.js bei jedem Deploy alle Dateien erneut ausführt.
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
