-- Phase 10: Projekt-Organisation
-- - file_size_bytes für sortierbare Größe
-- - created_by für Benutzer-Filter
-- - topics + project_topics für frei pflegbare Themenbereiche

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_file_size ON projects(file_size_bytes);

CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color VARCHAR(7) NOT NULL DEFAULT '#00B9F1',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_topics (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_project_topics_topic ON project_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_project_topics_project ON project_topics(project_id);
