import { SyncState } from './state-machine';
import type { AttemptRow, PhotoRow } from '../db/attempts-repo';

/**
 * What makes a half-finished capture worth keeping.
 *
 * A draft is the only mutable row in the system, so the rule that decides
 * whether one is real work or abandoned noise has to live in exactly one
 * place. It is needed both in TypeScript (the startup sweep classifies rows
 * it has already loaded) and in SQL (the stop list has to mark stops without
 * loading every draft on the device), and two hand-written copies of the same
 * predicate would drift the moment a field is added. So the field list is the
 * source of truth and the SQL is derived from it.
 *
 * `barcode_source` is not here: it rides along with the barcode and means
 * nothing on its own. `lat`/`lng` are not here either, because they are
 * written at submit rather than during capture, so treating them as evidence
 * would make a draft look substantive that the driver never touched.
 */
export const EVIDENCE_FIELDS = [
  'outcome',
  'reason_code',
  'neighbour_house_number',
  'note',
  'parcel_barcode',
  'signature_path',
] as const;

export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

/**
 * The same predicate as `isSubstantiveDraft`, for queries that must not pull
 * every draft row across the bridge to answer "does this stop have one?".
 *
 * Expects the attempts table aliased as `a`. The caller supplies the
 * `sync_state = 'draft'` guard, because only the caller knows whether it is
 * filtering rows or joining them.
 */
export const SUBSTANTIVE_DRAFT_SQL = `(
  ${EVIDENCE_FIELDS.map((f) => `nullif(trim(coalesce(a.${f}, '')), '') IS NOT NULL`).join('\n  OR ')}
  OR EXISTS (SELECT 1 FROM attempt_photos p WHERE p.client_attempt_id = a.client_attempt_id)
)`;

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/**
 * True when the driver put work into this draft that it would be rude to
 * throw away. Photos alone count: a photo is the most expensive thing to
 * re-capture, because the van has usually moved on by the time anyone
 * notices it is gone.
 */
export function isSubstantiveDraft(row: AttemptRow, photos: PhotoRow[]): boolean {
  // Never claim a row that has passed the finalize boundary. The callers all
  // filter on sync_state already; this is the backstop that makes a mistake
  // there a no-op rather than an append-only violation.
  if (row.sync_state !== SyncState.Draft) return false;
  if (photos.length > 0) return true;
  return EVIDENCE_FIELDS.some((field) => !isBlank(row[field]));
}

export interface DraftEntry {
  row: AttemptRow;
  photos: PhotoRow[];
}

export interface DraftSweepPlan {
  /** Drafts to keep and offer back to the driver. */
  resume: string[];
  /** Drafts holding nothing, safe to drop without telling anyone. */
  discard: string[];
}

/**
 * Splits the drafts found at startup into keep and drop.
 *
 * Anything past `draft` appears in neither list. A submitted attempt is
 * evidence, and the sweep has no business having an opinion about it.
 */
export function planDraftSweep(entries: DraftEntry[]): DraftSweepPlan {
  const plan: DraftSweepPlan = { resume: [], discard: [] };

  for (const entry of entries) {
    if (entry.row.sync_state !== SyncState.Draft) continue;
    if (isSubstantiveDraft(entry.row, entry.photos)) {
      plan.resume.push(entry.row.client_attempt_id);
    } else {
      plan.discard.push(entry.row.client_attempt_id);
    }
  }

  return plan;
}

export interface DraftSnapshot {
  clientAttemptId: string;
  stopId: string;
  outcome: string | null;
  reasonCode: string | null;
  neighbourHouseNumber: string;
  note: string;
  parcelBarcode: string;
  barcodeSource: 'scanned' | 'manual';
  signaturePath: string | null;
  photos: PhotoRow[];
}

/**
 * Rebuilds the capture form from the row the driver left behind.
 *
 * Text fields come back as strings rather than nulls because they feed
 * controlled inputs, where a null would remount the field as uncontrolled and
 * silently drop what was restored.
 */
export function hydrateDraft(row: AttemptRow, photos: PhotoRow[]): DraftSnapshot {
  return {
    clientAttemptId: row.client_attempt_id,
    stopId: row.stop_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    neighbourHouseNumber: row.neighbour_house_number ?? '',
    note: row.note ?? '',
    parcelBarcode: row.parcel_barcode ?? '',
    // A barcode with no recorded source predates the source being captured.
    // Calling it "scanned" would overstate the provenance of the evidence, so
    // the weaker claim wins.
    barcodeSource: row.barcode_source === 'scanned' ? 'scanned' : 'manual',
    signaturePath: row.signature_path,
    photos: [...photos].sort((a, b) => a.photo_index - b.photo_index),
  };
}
