import { Outcome, validateEvidence, type EvidenceInput } from './outcomes';

const base: EvidenceInput = {
  hasSignature: false,
  photoCount: 0,
  reasonCode: null,
  neighbourHouseNumber: null,
};

describe('evidence matrix (the exact table from the brief)', () => {
  const cases: Array<[Outcome, Partial<EvidenceInput>, boolean, string]> = [
    // delivered_to_person: signature required
    [Outcome.DeliveredToPerson, { hasSignature: true }, true, 'signature satisfies'],
    [Outcome.DeliveredToPerson, {}, false, 'missing signature rejected'],
    // left_with_neighbour: house number + photo
    [Outcome.LeftWithNeighbour, { neighbourHouseNumber: '42', photoCount: 1 }, true, 'house number + photo satisfies'],
    [Outcome.LeftWithNeighbour, { photoCount: 1 }, false, 'missing house number rejected'],
    [Outcome.LeftWithNeighbour, { neighbourHouseNumber: '42' }, false, 'missing photo rejected'],
    // left_safe_place: photo mandatory (the photo IS the proof)
    [Outcome.LeftSafePlace, { photoCount: 1 }, true, 'photo satisfies'],
    [Outcome.LeftSafePlace, {}, false, 'missing photo rejected'],
    // no_answer_carded: photo of the card
    [Outcome.NoAnswerCarded, { photoCount: 1 }, true, 'card photo satisfies'],
    [Outcome.NoAnswerCarded, {}, false, 'missing card photo rejected'],
    // refused: reason
    [Outcome.Refused, { reasonCode: 'customer_refused' }, true, 'reason satisfies'],
    [Outcome.Refused, {}, false, 'missing reason rejected'],
    // access_failure: reason + photo optional
    [Outcome.AccessFailure, { reasonCode: 'gate_locked' }, true, 'reason alone satisfies'],
    [Outcome.AccessFailure, { reasonCode: 'gate_locked', photoCount: 1 }, true, 'optional photo accepted'],
    [Outcome.AccessFailure, {}, false, 'missing reason rejected'],
  ];

  it.each(cases)('%s: %j -> valid=%s (%s)', (outcome, overrides, valid) => {
    const violations = validateEvidence(outcome, { ...base, ...overrides });
    if (valid) expect(violations).toEqual([]);
    else expect(violations.length).toBeGreaterThan(0);
  });

  it('rejects cross-outcome evidence smuggling (signature on refused)', () => {
    expect(
      validateEvidence(Outcome.Refused, { ...base, hasSignature: true, reasonCode: 'x' }),
    ).toContain('refused must not include a signature');
  });

  it('caps photos at 4 for every outcome', () => {
    expect(
      validateEvidence(Outcome.LeftSafePlace, { ...base, photoCount: 5 }),
    ).toContain('at most 4 photos are allowed');
  });
});
