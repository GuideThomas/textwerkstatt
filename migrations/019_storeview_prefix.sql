-- Phase 19 (27.05.2026): Storeview-Praefix-Toggle pro Projekt
--
-- Hintergrund (Sabrina 27.05.2026): Magento-Storeviews trennen Sprachen ueber
-- URL-Segmente (/fr/, /it/, ...). Wenn ein CMS-Block einen relativen Link
-- `<a href="/led-praxis">` enthaelt und beim FR-Storeview importiert wird, fehlt
-- das `/fr`-Praefix — Link zeigt auf die Default-Storeview statt FR.
--
-- Toggle ist OPT-IN pro Projekt. Default FALSE damit Bestandsverhalten erhalten
-- bleibt. Greift nur fuer Links OHNE bereits vorhandenes Locale-Praefix (siehe
-- protectUrlSlugs fuer den Locale-Swap-Pfad).
--
-- Aus Sabrinas Vorgabe (Auswahl 27.05.2026):
--   - nur relative Links (/...) ohne Locale-Praefix → praefixieren
--   - tel:/mailto: ausschliessen
--   - Anchor-only (#...) ausschliessen
--   - Magento-Direktiven ({{widget}}/{{media}}/{{store}}) nicht anruehren
--   - Externe Links (https://...) nicht anruehren

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS inject_storeview_prefix BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN projects.inject_storeview_prefix IS
  'Wenn TRUE: relative href/src ohne Locale-Praefix bekommen /<target_lang>/-Prefix injiziert.';
