import {
  BARCODE_OVERRIDE_REASONS,
  Outcome,
  RETRY_TODAY_OUTCOMES,
  STOP_STATUS_BY_OUTCOME,
  barcodeMatches,
  displayStopStatus,
  validateEvidence,
  type EvidenceInput,
} from './outcomes';

/**
 * A barcode is present in the baseline because every real attempt has one: the
 * driver is holding the parcel. The outcome matrix below is about what else
 * each outcome needs, so it should not be re-testing the barcode rule in all
 * fourteen rows. That rule gets its own tests further down.
 */
const base: EvidenceInput = {
  hasSignature: false,
  photoCount: 0,
  reasonCode: null,
  neighbourHouseNumber: null,
  parcelBarcode: 'JD0001',
};

/**
 * The same matrix the server enforces. If these two ever drift, a driver
 * captures evidence the server will reject after the doorstep - so the
 * table is asserted independently on both sides.
 */
describe('evidence matrix (client-side, offline-capable)', () => {
  it.each<[Outcome, Partial<EvidenceInput>, boolean]>([
    [Outcome.DeliveredToPerson, { hasSignature: true }, true],
    [Outcome.DeliveredToPerson, {}, false],
    [Outcome.LeftWithNeighbour, { neighbourHouseNumber: '42', photoCount: 1 }, true],
    [Outcome.LeftWithNeighbour, { photoCount: 1 }, false],
    [Outcome.LeftWithNeighbour, { neighbourHouseNumber: '42' }, false],
    [Outcome.LeftSafePlace, { photoCount: 1 }, true],
    [Outcome.LeftSafePlace, {}, false],
    [Outcome.NoAnswerCarded, { photoCount: 1 }, true],
    [Outcome.NoAnswerCarded, {}, false],
    [Outcome.Refused, { reasonCode: 'Customer refused' }, true],
    [Outcome.Refused, {}, false],
    [Outcome.AccessFailure, { reasonCode: 'Gate locked' }, true],
    [Outcome.AccessFailure, { reasonCode: 'Gate locked', photoCount: 2 }, true],
    [Outcome.AccessFailure, {}, false],
  ])('%s with %j is valid=%s', (outcome, overrides, valid) => {
    const violations = validateEvidence(outcome, { ...base, ...overrides });
    expect(violations.length === 0).toBe(valid);
  });

  it('caps photos at four per attempt', () => {
    expect(validateEvidence(Outcome.LeftSafePlace, { ...base, photoCount: 5 })).toContain(
      'At most 4 photos',
    );
  });

  it('gives the driver one actionable message, not a wall of errors', () => {
    const violations = validateEvidence(Outcome.LeftWithNeighbour, base);
    expect(violations[0]).toMatch(/photo|house number/i);
  });
});

/**
 * The brief: "Every attempt also captures ... the scanned or manually entered
 * parcel barcode."
 *
 * Absence and mismatch are different rules and pull in opposite directions. A
 * missing barcode blocks, because an attempt against no parcel is not evidence
 * of anything. A mismatched barcode never blocks, because a driver who cannot
 * record what happened records something else instead.
 */
describe('the parcel barcode is required, whatever the outcome', () => {
  it.each(Object.values(Outcome))('blocks %s when the field is empty', (outcome) => {
    // Enough evidence for every outcome, so the barcode is the only thing left
    // that can be wrong.
    const satisfied: EvidenceInput = {
      hasSignature: outcome === Outcome.DeliveredToPerson,
      photoCount: 1,
      reasonCode: ([Outcome.Refused, Outcome.AccessFailure] as Outcome[]).includes(outcome)
        ? 'Gate locked'
        : null,
      neighbourHouseNumber: outcome === Outcome.LeftWithNeighbour ? '42' : null,
      parcelBarcode: null,
    };

    expect(validateEvidence(outcome, satisfied)).toContain('Scan or type the parcel barcode');
    expect(validateEvidence(outcome, { ...satisfied, parcelBarcode: 'JD0001' })).not.toContain(
      'Scan or type the parcel barcode',
    );
  });

  it('treats whitespace as empty', () => {
    expect(validateEvidence(Outcome.LeftSafePlace, { ...base, photoCount: 1, parcelBarcode: '   ' })).toContain(
      'Scan or type the parcel barcode',
    );
  });

  it('accepts a typed barcode exactly as it accepts a scanned one', () => {
    // validateEvidence sees a string, not a provenance. Manual entry is a
    // first-class path: scanners fail and labels get damaged, and the source is
    // recorded separately on the attempt.
    expect(
      validateEvidence(Outcome.LeftSafePlace, { ...base, photoCount: 1, parcelBarcode: 'JD0009' }),
    ).toEqual([]);
  });

  it('still blocks when the barcode is missing AND other evidence is missing', () => {
    // Both violations surface; the barcode does not mask the rest.
    const violations = validateEvidence(Outcome.LeftSafePlace, { ...base, photoCount: 0, parcelBarcode: null });
    expect(violations).toContain('Scan or type the parcel barcode');
    expect(violations).toContain('At least 1 photo needed');
  });

  it('does not block on a mismatch: that is the override path, not this rule', () => {
    // A barcode that is present but wrong satisfies THIS rule. The mismatch is
    // handled separately, by asking for a reason, and never by refusing the
    // attempt.
    expect(
      validateEvidence(Outcome.LeftSafePlace, { ...base, photoCount: 1, parcelBarcode: 'WRONG-LABEL' }),
    ).toEqual([]);
  });
});

/**
 * The barcode check exists to record a discrepancy, never to prevent one.
 *
 * Blocking on a mismatch does not stop bad data reaching the system, it
 * manufactures it: a driver who cannot record what actually happened records
 * something else to get past the block, and a coerced clean scan is worse
 * evidence than a recorded override with a reason attached.
 */
describe('barcode comparison', () => {
  it('says nothing when there is nothing to compare against', () => {
    // Null is a third answer, not a soft no. The server stores "no expected
    // value" differently from "compared, and it differed".
    expect(barcodeMatches(null, 'JD0001')).toBeNull();
    expect(barcodeMatches('JD0001', null)).toBeNull();
    expect(barcodeMatches('JD0001', '')).toBeNull();
    expect(barcodeMatches('   ', 'JD0001')).toBeNull();
  });

  it('matches on the value, not on its formatting', () => {
    // A scanner returning a trailing newline, or a driver typing lower case,
    // is not a discrepancy worth interrupting someone at a doorstep for.
    expect(barcodeMatches('JD0001', 'jd0001')).toBe(true);
    expect(barcodeMatches('JD0001', ' JD0001 ')).toBe(true);
    expect(barcodeMatches('JD0001', 'JD0001\n')).toBe(true);
  });

  it('reports a real difference as a mismatch', () => {
    expect(barcodeMatches('JD0001', 'JD0002')).toBe(false);
  });

  it('offers a closed list of override reasons', () => {
    // Free text cannot be counted. "Wrong label" typed six ways is six things
    // to a report and one thing to a human.
    expect(BARCODE_OVERRIDE_REASONS.length).toBeGreaterThan(0);
    expect(new Set(BARCODE_OVERRIDE_REASONS).size).toBe(BARCODE_OVERRIDE_REASONS.length);
  });
});

/**
 * stops.status is written only by a route pull, so offline it is whatever
 * dispatch last sent. Without this the app disbelieves evidence it is holding:
 * a driver delivers in a basement, the attempt queues correctly, and the stop
 * still reads pending with the header counting it as outstanding.
 */
describe('the stop list believes the evidence on the phone', () => {
  it('keeps the server status when the driver has recorded nothing', () => {
    expect(displayStopStatus('pending', null)).toBe('pending');
    expect(displayStopStatus('pending', undefined)).toBe('pending');
    expect(displayStopStatus('attempted', '')).toBe('attempted');
  });

  it('marks a stop delivered from a local attempt, with no pull', () => {
    for (const outcome of [
      Outcome.DeliveredToPerson,
      Outcome.LeftWithNeighbour,
      Outcome.LeftSafePlace,
    ]) {
      expect(displayStopStatus('pending', outcome)).toBe('delivered');
    }
  });

  it('treats a refusal as settled and carded as still open', () => {
    // The distinction the day count depends on: refused is finished, carded is
    // not, and both are "attempted" to the driver until dispatch says more.
    expect(displayStopStatus('pending', Outcome.Refused)).toBe('failed');
    expect(displayStopStatus('pending', Outcome.NoAnswerCarded)).toBe('attempted');
    expect(displayStopStatus('pending', Outcome.AccessFailure)).toBe('attempted');
  });

  it('lets the local attempt override a stale server status', () => {
    // The pull said pending because it happened before the delivery. Evidence
    // outranks the list, which is the same ordering the conflict rule uses.
    expect(displayStopStatus('pending', Outcome.LeftSafePlace)).toBe('delivered');
  });

  it('falls back to the server status if the outcome is unrecognised', () => {
    // A row written by a newer build than this one. Showing dispatch's answer
    // beats inventing a status the rest of the UI has no styling for.
    expect(displayStopStatus('attempted', 'teleported_it')).toBe('attempted');
  });

  it('maps every outcome, so a new one cannot silently fall through', () => {
    for (const outcome of Object.values(Outcome)) {
      expect(STOP_STATUS_BY_OUTCOME[outcome]).toBeDefined();
    }
  });
});

describe('retry today applies only where the question is real', () => {
  it('covers carded and no-access, and nothing settled', () => {
    expect(RETRY_TODAY_OUTCOMES).toEqual([Outcome.NoAnswerCarded, Outcome.AccessFailure]);
    for (const settled of [Outcome.DeliveredToPerson, Outcome.LeftSafePlace, Outcome.Refused]) {
      expect(RETRY_TODAY_OUTCOMES).not.toContain(settled);
    }
  });
});
