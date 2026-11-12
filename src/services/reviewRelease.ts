/**
 * Freigabe einer Übersetzung durch einen Native Speaker.
 *
 * Eine Freigabe gilt für ein ganzes Projekt und hält den Fingerabdruck der
 * finalen Texte fest (`content_hash`). Stimmt der Fingerabdruck nicht mehr,
 * gilt die Freigabe nicht mehr — egal, auf welchem Weg der Text geändert wurde
 * (Editor, Kürzen, Neuübersetzung, Terminologie-Scan, anderes Projekt mit
 * demselben Segment). Hintergrund und Regeln: migrations/023_review_release.sql.
 *
 * Zwei Stellen heben eine Freigabe auf, beide über `enforceRelease`:
 *   - sofort, wenn im Review-Editor ein Text geändert, ein Haken entfernt oder
 *     eine Rückfrage gestellt wird (`revokeForSegments`);
 *   - beim nächsten Lesen des Status, wenn der Text woanders geändert wurde
 *     (`getReleaseStatus`). Die Mail geht dann erst in diesem Moment raus,
 *     nicht im Augenblick der Änderung.
 */

import crypto from 'crypto';
import { pool } from '../db/connection';
import { config } from '../config';
import {
  sendMail,
  buildReleaseConfirmedEmail,
  buildReleaseDoneByOtherEmail,
  mailLangFor,
  buildReleaseRevokedEmail,
} from './email';

export type RevokeReason = 'text_changed' | 'unapproved' | 'clarification';

interface Actor {
  id: string;
  email: string;
  name: string | null;
  display_name: string | null;
}

interface ProjectInfo {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  created_by: string | null;
}

interface ReleaseRow {
  id: string;
  project_id: string;
  released_by: string | null;
  released_by_name: string;
  released_by_email: string;
  released_at: Date;
  content_hash: string;
  segment_count: number;
  revoked_at: Date | null;
  revoked_reason: string | null;
  revoked_by_name: string | null;
}

export interface ReleaseReadiness {
  translated: number;
  approved: number;
  open: number;
  clarification: number;
  ready: boolean;
}

function actorName(a: { display_name: string | null; name: string | null; email: string }): string {
  return a.display_name || a.name || a.email;
}

function projectUrl(projectId: string): string {
  return `${config.publicUrl.replace(/\/$/, '')}/?project=${projectId}`;
}

async function loadProject(projectId: string): Promise<ProjectInfo | null> {
  const res = await pool.query<ProjectInfo>(
    `SELECT id, name, source_lang, target_lang, created_by FROM projects WHERE id = $1`,
    [projectId],
  );
  return res.rows[0] ?? null;
}

/**
 * Fingerabdruck über die Texte, die beim Download in der Datei landen —
 * dieselbe Auswahl wie GET /download (condensed vor translated).
 */
export async function computeContentHash(projectId: string): Promise<string> {
  const res = await pool.query<{ id: string; final_text: string | null }>(
    `SELECT ps.id, COALESCE(s.condensed_text, s.translated_text) AS final_text
       FROM project_segments ps
       JOIN segments s ON ps.segment_id = s.id
      WHERE ps.project_id = $1
      ORDER BY ps.position, ps.id`,
    [projectId],
  );
  const hash = crypto.createHash('sha256');
  for (const row of res.rows) {
    // JSON je Zeile trennt eindeutig: ["a","bc"] und ["ab","c"] ergeben verschiedene Hashes,
    // und ein fehlender Text (null) unterscheidet sich vom leeren.
    hash.update(JSON.stringify([row.id, row.final_text]));
  }
  return hash.digest('hex');
}

export async function getReadiness(projectId: string): Promise<ReleaseReadiness> {
  const res = await pool.query<{ translated: string; approved: string; clarification: string }>(
    `SELECT
        COUNT(*) FILTER (WHERE s.translated_text IS NOT NULL OR s.condensed_text IS NOT NULL) AS translated,
        COUNT(*) FILTER (WHERE (s.translated_text IS NOT NULL OR s.condensed_text IS NOT NULL)
                           AND s.review_status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE s.review_status = 'needs_clarification') AS clarification
       FROM project_segments ps
       JOIN segments s ON ps.segment_id = s.id
      WHERE ps.project_id = $1`,
    [projectId],
  );
  const row = res.rows[0];
  const translated = parseInt(row.translated, 10) || 0;
  const approved = parseInt(row.approved, 10) || 0;
  const clarification = parseInt(row.clarification, 10) || 0;
  const open = translated - approved;
  return {
    translated,
    approved,
    open,
    clarification,
    ready: translated > 0 && open === 0 && clarification === 0,
  };
}

/** Darf dieser Benutzer freigeben? Nur, wer für das Projekt angefragt wurde. */
async function isInvitedReviewer(projectId: string, email: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM review_invitations
      WHERE project_id = $1 AND delivery_status = 'sent'
        AND LOWER(speaker_email) = LOWER($2)
      LIMIT 1`,
    [projectId, email],
  );
  return res.rows.length > 0;
}

/**
 * Wer die Prüfung angefragt hat. Fehlt eine Anfrage (Altbestand), fällt die
 * Meldung an die Person, die das Projekt angelegt hat.
 */
async function loadRequesters(project: ProjectInfo): Promise<Array<{ id: string; email: string; label: string }>> {
  const res = await pool.query<{ id: string; email: string; display_name: string | null; name: string | null }>(
    `SELECT DISTINCT u.id, u.email, u.display_name, u.name
       FROM users u
      WHERE u.active = TRUE
        AND (u.id IN (SELECT requested_by FROM review_invitations WHERE project_id = $1)
             OR (u.id = $2 AND NOT EXISTS (
                   SELECT 1 FROM review_invitations WHERE project_id = $1 AND requested_by IS NOT NULL)))`,
    [project.id, project.created_by],
  );
  return res.rows.map((u) => ({ id: u.id, email: u.email, label: actorName(u) }));
}

async function loadActiveRelease(projectId: string): Promise<ReleaseRow | null> {
  const res = await pool.query<ReleaseRow>(
    `SELECT r.*, NULL::text AS revoked_by_name
       FROM review_releases r
      WHERE r.project_id = $1 AND r.revoked_at IS NULL`,
    [projectId],
  );
  return res.rows[0] ?? null;
}

/**
 * Hebt die Freigabe auf und meldet das der anfragenden Person. Gibt false
 * zurück, wenn eine parallele Anfrage schneller war (dann meldet jene).
 */
async function revokeRelease(
  project: ProjectInfo,
  release: ReleaseRow,
  reason: RevokeReason,
  actor: Actor | null,
): Promise<boolean> {
  const upd = await pool.query(
    `UPDATE review_releases
        SET revoked_at = NOW(), revoked_reason = $2, revoked_by = $3
      WHERE id = $1 AND revoked_at IS NULL`,
    [release.id, reason, actor?.id ?? null],
  );
  if (!upd.rowCount) return false;

  const changedByName = actor ? actorName(actor) : null;
  const requesters = await loadRequesters(project);
  for (const r of requesters) {
    // Wer selbst geändert hat, weiß es schon.
    if (actor && r.id === actor.id) continue;
    const mail = buildReleaseRevokedEmail({
      recipientName: r.label,
      reviewerName: release.released_by_name,
      releasedAt: new Date(release.released_at),
      reason,
      changedByName,
      projectName: project.name,
      sourceLang: project.source_lang,
      targetLang: project.target_lang,
      projectUrl: projectUrl(project.id),
    });
    await sendMail({ to: r.email, ...mail });
  }
  console.log(`[Release] Projekt ${project.id}: Freigabe ${release.id} aufgehoben (${reason})`);
  return true;
}

/**
 * Gilt die Freigabe noch? Aufgehoben wird, wenn sich der Text geändert hat
 * oder die Voraussetzung (alles abgehakt, keine Rückfrage) nicht mehr gilt.
 * Gibt true zurück, wenn die Freigabe weiter gilt.
 */
async function enforceRelease(project: ProjectInfo, active: ReleaseRow, actor: Actor | null): Promise<boolean> {
  const readiness = await getReadiness(project.id);
  const hash = await computeContentHash(project.id);
  let reason: RevokeReason | null = null;
  if (hash !== active.content_hash) reason = 'text_changed';
  else if (readiness.clarification > 0) reason = 'clarification';
  else if (!readiness.ready) reason = 'unapproved';
  if (!reason) return true;
  await revokeRelease(project, active, reason, actor);
  return false;
}

export async function getReleaseStatus(projectId: string, viewer: Actor) {
  const project = await loadProject(projectId);
  if (!project) return null;

  let active = await loadActiveRelease(projectId);
  // Zweite Schicht hinter revokeForSegments: fängt Änderungen außerhalb des
  // Editors (Kürzen, Neuübersetzung, …) und einen dort gescheiterten Aufruf.
  if (active && !(await enforceRelease(project, active, null))) active = null;
  const readiness = await getReadiness(projectId);

  const lastRevoked = active
    ? null
    : (await pool.query<ReleaseRow>(
        `SELECT r.*, COALESCE(u.display_name, u.name, u.email) AS revoked_by_name
           FROM review_releases r
           LEFT JOIN users u ON u.id = r.revoked_by
          WHERE r.project_id = $1 AND r.revoked_at IS NOT NULL
          ORDER BY r.revoked_at DESC
          LIMIT 1`,
        [projectId],
      )).rows[0] ?? null;

  const invitations = await pool.query<{ speaker_name: string; speaker_email: string; sent_at: Date }>(
    `SELECT DISTINCT ON (LOWER(i.speaker_email))
            s.name AS speaker_name, i.speaker_email, i.sent_at
       FROM review_invitations i
       JOIN native_speakers s ON s.id = i.speaker_id
      WHERE i.project_id = $1 AND i.delivery_status = 'sent'
      ORDER BY LOWER(i.speaker_email), i.sent_at DESC`,
    [projectId],
  );

  const invited = await isInvitedReviewer(projectId, viewer.email);

  const pick = (r: ReleaseRow | null) => r && {
    released_by_name: r.released_by_name,
    released_by_email: r.released_by_email,
    released_at: r.released_at,
    segment_count: r.segment_count,
    revoked_at: r.revoked_at,
    revoked_reason: r.revoked_reason,
    revoked_by_name: r.revoked_by_name,
  };

  return {
    released: !!active,
    release: pick(active),
    last_revoked: pick(lastRevoked),
    invitations: invitations.rows,
    readiness,
    viewer_is_reviewer: invited,
    can_release: invited && !active && readiness.ready,
  };
}

export class ReleaseError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function releaseProject(projectId: string, actor: Actor) {
  const project = await loadProject(projectId);
  if (!project) throw new ReleaseError(404, 'Projekt nicht gefunden');

  if (!(await isInvitedReviewer(projectId, actor.email))) {
    throw new ReleaseError(403, 'Freigeben kann nur, wer für dieses Projekt um ein Review gebeten wurde.');
  }

  const readiness = await getReadiness(projectId);
  if (!readiness.ready) {
    const parts: string[] = [];
    if (readiness.open > 0) parts.push(`${readiness.open} Segmente noch nicht abgehakt`);
    if (readiness.clarification > 0) parts.push(`${readiness.clarification} Rückfragen offen`);
    if (readiness.translated === 0) parts.push('noch keine übersetzten Segmente');
    throw new ReleaseError(409, `Freigabe noch nicht möglich: ${parts.join(', ')}.`);
  }

  const reviewerName = actorName(actor);
  const hash = await computeContentHash(projectId);
  let releaseId: string;
  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO review_releases
         (project_id, released_by, released_by_name, released_by_email, content_hash, segment_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [projectId, actor.id, reviewerName, actor.email, hash, readiness.translated],
    );
    releaseId = ins.rows[0].id;
  } catch (err: any) {
    // idx_review_releases_active: jemand anderes war schneller.
    if (err.code === '23505') {
      throw new ReleaseError(409, 'Diese Übersetzung wurde soeben bereits freigegeben.');
    }
    throw err;
  }
  console.log(`[Release] Projekt ${projectId}: freigegeben von ${actor.email} (${releaseId})`);

  const common = {
    projectName: project.name,
    sourceLang: project.source_lang,
    targetLang: project.target_lang,
    projectUrl: projectUrl(projectId),
  };

  const mailFailures: string[] = [];

  for (const r of await loadRequesters(project)) {
    if (r.id === actor.id) continue;
    const mail = buildReleaseConfirmedEmail({
      ...common,
      recipientName: r.label,
      reviewerName,
      segmentCount: readiness.translated,
    });
    const result = await sendMail({ to: r.email, ...mail, replyTo: actor.email });
    if (!result.ok) mailFailures.push(r.email);
  }

  // Die übrigen Angefragten: bereits erledigt. Je Adresse nur eine Mail,
  // auch wenn sie mehrfach angefragt wurde.
  const others = await pool.query<{ speaker_email: string; speaker_name: string }>(
    `SELECT DISTINCT ON (LOWER(i.speaker_email)) i.speaker_email, s.name AS speaker_name
       FROM review_invitations i
       JOIN native_speakers s ON s.id = i.speaker_id
      WHERE i.project_id = $1 AND i.delivery_status = 'sent'
        AND LOWER(i.speaker_email) <> LOWER($2)
      ORDER BY LOWER(i.speaker_email), i.sent_at DESC`,
    [projectId, actor.email],
  );
  for (const o of others.rows) {
    const mail = buildReleaseDoneByOtherEmail({
      ...common,
      recipientName: o.speaker_name,
      reviewerName,
      lang: mailLangFor(project.target_lang),
    });
    const result = await sendMail({ to: o.speaker_email, ...mail });
    if (!result.ok) mailFailures.push(o.speaker_email);
  }

  return { released: true, mail_failures: mailFailures };
}

/**
 * Nach einer Änderung im Review-Editor (Text, Haken entfernt, Rückfrage):
 * Freigaben aller Projekte prüfen, die eines der Segmente enthalten — ein
 * Segment kann in mehreren Projekten stecken. Aufgehoben wird nur, was
 * `enforceRelease` nicht mehr trägt; Speichern ohne Änderung hebt nichts auf.
 * Ein Fehler hier darf die eigentliche Änderung nicht scheitern lassen; die
 * Statusabfrage prüft beim nächsten Lesen ohnehin erneut.
 */
export async function revokeForSegments(segmentIds: string[], actor: Actor | null): Promise<void> {
  if (segmentIds.length === 0) return;
  try {
    const res = await pool.query<{ project_id: string }>(
      `SELECT DISTINCT r.project_id
         FROM review_releases r
         JOIN project_segments ps ON ps.project_id = r.project_id
        WHERE r.revoked_at IS NULL AND ps.segment_id = ANY($1::uuid[])`,
      [segmentIds],
    );
    for (const { project_id } of res.rows) {
      const project = await loadProject(project_id);
      const active = await loadActiveRelease(project_id);
      if (!project || !active) continue;
      await enforceRelease(project, active, actor);
    }
  } catch (err) {
    console.error('[Release] Prüfen der Freigabe nach Änderung fehlgeschlagen:', err);
  }
}
