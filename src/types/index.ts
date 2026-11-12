export interface Project {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  file_type: FileType;
  status: ProjectStatus;
  original_filename: string | null;
  stored_filename: string | null;
  segment_count: number;
  created_at: Date;
  updated_at: Date;
}

export type FileType = 'idml' | 'docx' | 'xlsx' | 'pdf' | 'xml' | 'html' | 'txt' | 'csv' | 'md' | 'aijson';
export type ProjectStatus = 'pending' | 'processing' | 'translating' | 'condensing' | 'completed' | 'error';

export type ReviewStatus = 'pending' | 'approved' | 'edited';
export type CondenseStatus = 'condensed' | 'still_long' | 'manual_review' | null;

export interface Segment {
  id: string;
  segment_hash: string;
  source_lang: string;
  target_lang: string;
  source_text: string;
  translated_text: string | null;
  condensed_text: string | null;
  glossary_version: number;
  is_stale: boolean;
  hit_count: number;
  review_status: ReviewStatus;
  edited_by_user: boolean;
  original_translation: string | null;
  created_at: Date;
}

export interface Glossary {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  version: number;
  deepl_glossary_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface GlossaryEntry {
  id: string;
  glossary_id: string;
  source_term: string;
  target_term: string;
  context: string | null;
  category: string | null;
  approved: boolean;
  source: 'manual' | 'auto-detected' | 'csv-import';
  created_at: Date;
}

export interface Job {
  id: string;
  project_id: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export type JobType = 'translate' | 'terminology-scan' | 'glossary-sync';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'error';

/** Zuordnung Projekt ↔ extrahiertes Segment mit IDML-Metadaten */
export interface ProjectSegment {
  id: string;
  project_id: string;
  segment_id: string | null;
  idml_segment_id: string;
  story_file: string | null;
  paragraph_index: number | null;
  content_map: any | null;
  max_chars: number | null;
  position: number;
  condense_status: CondenseStatus;
  source_text?: string;        // JOIN aus segments
  translated_text?: string;    // JOIN aus segments
  condensed_text?: string;     // JOIN aus segments
  review_status?: ReviewStatus; // JOIN aus segments
  edited_by_user?: boolean;    // JOIN aus segments
  original_translation?: string; // JOIN aus segments
  created_at: Date;
}

export interface TokenUsage {
  id: string;
  project_id: string | null;
  segment_id: string | null;
  model: string;
  purpose: 'condense' | 'terminology' | 'analyze';
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: Date;
}

export interface CreateProjectRequest {
  name: string;
  source_lang: string;
  target_lang: string;
}

export const SUPPORTED_FILE_TYPES: Record<string, FileType> = {
  '.idml': 'idml',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pdf': 'pdf',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'txt',
  '.csv': 'csv',
  '.md': 'md',
  '.markdown': 'md',
  // Illustrator-Austauschformat (export-text.jsx). Eigene Endung, damit
  // generische .json-Dateien nicht faelschlich als Uebersetzungsjob landen.
  '.aijson': 'aijson',
};

export const SUPPORTED_LANGUAGES = [
  { code: 'DE', name: 'Deutsch' },
  { code: 'EN', name: 'English' },
  { code: 'IT', name: 'Italiano' },
  { code: 'FR', name: 'Francais' },
  { code: 'ES', name: 'Español' },
  { code: 'NL', name: 'Nederlands' },
  { code: 'PL', name: 'Polski' },
  { code: 'CS', name: 'Cestina' },
  { code: 'HU', name: 'Magyar' },
  { code: 'SK', name: 'Slovencina' },
] as const;

export interface TerminologyCandidate {
  sourceTerm: string;
  targetTerm: string;
  originalTargetTerm: string;
  confidence: number;
  context?: string;
}

export interface TokenUsageStats {
  totalCost: number;
  byModel: { model: string; count: number; cost: number }[];
  byPurpose: { purpose: string; count: number; cost: number }[];
}

// --- Phase 5: Batch-Terminologie-Scan ---

export type ScanStatus = 'pending' | 'aligning' | 'translating' | 'analyzing' | 'completed' | 'error';
export type CandidateCategory = 'TERMINOLOGY' | 'STYLE' | 'ERROR' | 'CONTEXT';
export type CandidateStatus = 'pending' | 'approved' | 'rejected';
export type ScanFileType = 'idml' | 'docx' | 'xlsx' | 'txt';

export interface TerminologyScan {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  source_file_type: ScanFileType;
  source_filename: string | null;
  translation_filename: string | null;
  status: ScanStatus;
  total_segments: number;
  diff_segments: number;
  candidate_count: number;
  glossary_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TerminologyScanCandidate {
  id: string;
  scan_id: string;
  source_text: string;
  existing_translation: string;
  deepl_translation: string;
  source_term: string;
  existing_term: string;
  deepl_term: string;
  category: CandidateCategory;
  confidence: number;
  explanation: string | null;
  status: CandidateStatus;
  glossary_entry_id: string | null;
  position: number;
  created_at: Date;
}

export interface AlignedSegment {
  position: number;
  sourceText: string;
  existingTranslation: string;
}

export interface DiffSegment extends AlignedSegment {
  deeplTranslation: string;
}

export const SCAN_SUPPORTED_EXTENSIONS: Record<string, ScanFileType> = {
  '.idml': 'idml',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.txt': 'txt',
};
