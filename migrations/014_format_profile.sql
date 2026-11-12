-- Phase 14b: Format-Profile fuer CSV/XML
-- Bei Magento-Exports muessen technische Spalten (identifier, page_layout, ...)
-- unangetastet bleiben und HTML-Spalten via DeepL HTML-Modus laufen. Das Profil
-- entscheidet was uebersetzt wird und was nicht.
--
-- Wert 'auto' = Header-basierte Auto-Erkennung (Default).
-- Andere Werte: 'magento-cms-page', 'magento-product', 'generic-csv'.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS format_profile VARCHAR(50) NOT NULL DEFAULT 'auto';
