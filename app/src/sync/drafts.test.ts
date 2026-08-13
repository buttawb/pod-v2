import {
  EVIDENCE_FIELDS,
  SUBSTANTIVE_DRAFT_SQL,
  hydrateDraft,
  isSubstantiveDraft,
  planDraftSweep,
} from './drafts';
import { PhotoUploadState, SyncState } from './state-machine';
import type { AttemptRow, PhotoRow } from '../db/attempts-repo';

function draft(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    client_attempt_id: 'attempt-1',
    stop_id: 'stop-1',
    attempt_no: 1,
    outcome: null,
    reason_code: null,
    neighbour_house_number: null,
    note: null,
    parcel_barcode: null,
    barcode_source: null,
    barcode_match: null,
    barcode_override_reason: null,
    retry_today: 0,
    signature_path: null,
    lat: null,
    lng: null,
    gps_accuracy_m: null,
    captured_at: '2026-08-12T09:14:00.000Z',
    captured_at_monotonic: 8_400,
    driver_id: 'driver-1',
    device_id: 'device-1',
    app_version: '1.0.0',
    sync_state: SyncState.Draft,
    retry_count: 0,
    next_retry_at: null,
    failure_kind: null,
    last_error_code: null,
    last_error_message: null,
    server_attempt_id: null,
    finalized_at: null,
    synced_at: null,
    ...overrides,
  };
}

function photo(index: number, overrides: Partial<PhotoRow> = {}): PhotoRow {
  return {
    client_attempt_id: 'attempt-1',
    photo_index: index,
    kind: 'photo',
    local_path: `file:///evidence/attempt-1-${index}.jpg`,
    byte_size: 431_000,
    upload_state: PhotoUploadState.Pending,
    retry_count: 0,
    confirmed_at: null,
    ...overrides,
  };
}

/**
 * The reported bug, as a test: a driver captures, the phone is force-quit
 * before Submit, and reopening the stop has to give the work back.
 */
describe('surviving a force-quit mid-capture', () => {
  it('keeps a draft that has evidence in it, with the photo URIs intact', () => {
    const row = draft({ outcome: 'left_safe_place', note: 'behind the green bin' });
    const photos = [photo(2), photo(0), photo(1)];

    expect(planDraftSweep([{ row, photos }])).toEqual({ resume: ['attempt-1'], discard: [] });

    const snapshot = hydrateDraft(row, photos);
    expect(snapshot.photos.map((p) => p.local_path)).toEqual([
      'file:///evidence/attempt-1-0.jpg',
      'file:///evidence/attempt-1-1.jpg',
      'file:///evidence/attempt-1-2.jpg',
    ]);
    expect(snapshot.outcome).toBe('left_safe_place');
    expect(snapshot.note).toBe('behind the green bin');
  });

  it('counts a draft holding only photos as work worth keeping', () => {
    expect(isSubstantiveDraft(draft(), [photo(0)])).toBe(true);
  });

  it('restores text fields as strings, never null, so the inputs stay controlled', () => {
    const snapshot = hydrateDraft(draft(), []);
    expect(snapshot.note).toBe('');
    expect(snapshot.neighbourHouseNumber).toBe('');
    expect(snapshot.parcelBarcode).toBe('');
  });

  it('does not overstate provenance when a barcode has no recorded source', () => {
    expect(hydrateDraft(draft({ parcel_barcode: 'JD0002' }), []).barcodeSource).toBe('manual');
    expect(
      hydrateDraft(draft({ parcel_barcode: 'JD0002', barcode_source: 'scanned' }), []).barcodeSource,
    ).toBe('scanned');
  });
});

describe('discarding blank drafts', () => {
  it('drops a draft the driver never put anything into', () => {
    expect(planDraftSweep([{ row: draft(), photos: [] }])).toEqual({
      resume: [],
      discard: ['attempt-1'],
    });
  });

  it('treats a whitespace-only note as blank', () => {
    expect(isSubstantiveDraft(draft({ note: '   \n ' }), [])).toBe(false);
  });
});

/**
 * The append-only guarantee. Once an attempt is past `draft` the sweep has no
 * opinion about it, whatever else is true of the row.
 */
describe('submitted attempts are untouchable', () => {
  const submitted = Object.values(SyncState).filter((s) => s !== SyncState.Draft);

  it('leaves every non-draft state out of both lists', () => {
    for (const sync_state of submitted) {
      const row = draft({ sync_state, outcome: 'delivered_to_person' });
      expect(planDraftSweep([{ row, photos: [photo(0)] }])).toEqual({ resume: [], discard: [] });
      expect(isSubstantiveDraft(row, [photo(0)])).toBe(false);
    }
  });

  it('still sweeps the drafts sitting alongside a submitted attempt', () => {
    const plan = planDraftSweep([
      { row: draft({ client_attempt_id: 'sent', sync_state: SyncState.Queued }), photos: [] },
      { row: draft({ client_attempt_id: 'kept', note: 'gate code 4412' }), photos: [] },
      { row: draft({ client_attempt_id: 'blank' }), photos: [] },
    ]);
    expect(plan).toEqual({ resume: ['kept'], discard: ['blank'] });
  });
});

/**
 * The SQL and the TypeScript check answer the same question in two languages.
 * If they ever drift, a stop list marker and the startup sweep disagree about
 * whether a driver has unfinished work.
 */
describe('the SQL predicate cannot drift from the field list', () => {
  it('reads exactly the fields the TypeScript check reads', () => {
    for (const field of EVIDENCE_FIELDS) {
      expect(SUBSTANTIVE_DRAFT_SQL).toContain(`a.${field}`);
      expect(isSubstantiveDraft(draft({ [field]: 'x' } as Partial<AttemptRow>), [])).toBe(true);
    }
    expect(SUBSTANTIVE_DRAFT_SQL.match(/nullif\(/g)).toHaveLength(EVIDENCE_FIELDS.length);
  });

  it('asks about photos too, so a photo-only draft is found by either route', () => {
    expect(SUBSTANTIVE_DRAFT_SQL).toContain('attempt_photos');
  });
});

/**
 * Force-quit during the location wait.
 *
 * This is the window the bounded fix exists to shrink, and it can never be
 * closed entirely: however short the budget, a driver can always kill the app
 * inside it. What must hold is that nothing is lost when they do. The attempt
 * has not been finalized yet, so it is still a draft, and the photos and
 * signature were written to disk at capture time rather than at submit.
 */
describe('force-quit while waiting for a fix', () => {
  it('leaves a resumable draft with the evidence intact', () => {
    // Exactly the row as it stands mid-submit: outcome chosen, photo and
    // signature already on disk, lat and lng not yet written because the race
    // had not resolved.
    const row = draft({
      outcome: 'delivered_to_person',
      signature_path: 'file:///evidence/attempt-1-signature.png',
      lat: null,
      lng: null,
      gps_accuracy_m: null,
    });
    const photos = [photo(0), photo(100, { kind: 'signature' })];

    expect(planDraftSweep([{ row, photos }])).toEqual({ resume: ['attempt-1'], discard: [] });

    const snapshot = hydrateDraft(row, photos);
    expect(snapshot.outcome).toBe('delivered_to_person');
    expect(snapshot.signaturePath).toBe('file:///evidence/attempt-1-signature.png');
    expect(snapshot.photos).toHaveLength(2);
  });

  it('does not treat a missing position as a reason to discard the draft', () => {
    // lat and lng are not evidence fields: they are written at submit, so
    // counting them would make a draft the driver had genuinely worked on look
    // blank whenever the fix lost its race.
    expect(isSubstantiveDraft(draft({ lat: null, lng: null }), [photo(0)])).toBe(true);
  });
});
