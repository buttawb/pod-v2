import {
  BARCODE_OVERRIDE_REASONS,
  Outcome,
  RETRY_TODAY_OUTCOMES,
  barcodeMatches,
  validateEvidence,
  type EvidenceInput,
} from './outcomes';

const base: EvidenceInput = {
  hasSignature: false,
  photoCount: 0,
  reasonCode: null,
  neighbourHouseNumber: null,
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

describe('retry today applies only where the question is real', () => {
  it('covers carded and no-access, and nothing settled', () => {
    expect(RETRY_TODAY_OUTCOMES).toEqual([Outcome.NoAnswerCarded, Outcome.AccessFailure]);
    for (const settled of [Outcome.DeliveredToPerson, Outcome.LeftSafePlace, Outcome.Refused]) {
      expect(RETRY_TODAY_OUTCOMES).not.toContain(settled);
    }
  });
});
