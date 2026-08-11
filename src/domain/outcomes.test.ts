import { Outcome, validateEvidence, type EvidenceInput } from './outcomes';

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
