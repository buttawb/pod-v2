/**
 * Mirror of the server's evidence matrix (backend/src/domain/outcomes.ts).
 * Duplicated deliberately: the app must enforce the rules with no network,
 * so this cannot be fetched. The server re-validates everything on submit,
 * so a stale client can never write invalid evidence - it only ever gets a
 * clear rejection.
 */
export const Outcome = {
  DeliveredToPerson: 'delivered_to_person',
  LeftWithNeighbour: 'left_with_neighbour',
  LeftSafePlace: 'left_safe_place',
  NoAnswerCarded: 'no_answer_carded',
  Refused: 'refused',
  AccessFailure: 'access_failure',
} as const;

export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export const MAX_PHOTOS_PER_ATTEMPT = 4;

export interface OutcomeSpec {
  label: string;
  /** What the driver is told they must capture, in plain words. */
  evidenceHint: string;
  signature: 'required' | 'forbidden';
  photos: { min: number; max: number };
  reason: 'required' | 'forbidden';
  neighbourHouseNumber: 'required' | 'forbidden';
}

export const OUTCOME_SPECS: Record<Outcome, OutcomeSpec> = {
  [Outcome.DeliveredToPerson]: {
    label: 'Delivered to person',
    evidenceHint: 'Signature required',
    signature: 'required',
    photos: { min: 0, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.LeftWithNeighbour]: {
    label: 'Left with neighbour',
    evidenceHint: 'House number and a photo',
    signature: 'forbidden',
    photos: { min: 1, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'required',
  },
  [Outcome.LeftSafePlace]: {
    label: 'Left in safe place',
    evidenceHint: 'Photo required - the photo is the proof',
    signature: 'forbidden',
    photos: { min: 1, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.NoAnswerCarded]: {
    label: 'No answer / carded',
    evidenceHint: 'Photo of the card through the door',
    signature: 'forbidden',
    photos: { min: 1, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.Refused]: {
    label: 'Refused',
    evidenceHint: 'Reason required',
    signature: 'forbidden',
    photos: { min: 0, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'required',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.AccessFailure]: {
    label: 'Access failure',
    evidenceHint: 'Reason required, photo optional',
    signature: 'forbidden',
    photos: { min: 0, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'required',
    neighbourHouseNumber: 'forbidden',
  },
};

export const OUTCOME_ORDER: Outcome[] = [
  Outcome.DeliveredToPerson,
  Outcome.LeftSafePlace,
  Outcome.LeftWithNeighbour,
  Outcome.NoAnswerCarded,
  Outcome.AccessFailure,
  Outcome.Refused,
];

export const REASON_CODES: Record<string, string[]> = {
  [Outcome.Refused]: ['Customer refused', 'Wrong item', 'Damaged', 'Not ordered'],
  [Outcome.AccessFailure]: ['Gate locked', 'No access code', 'Blocked access', 'Dog in garden'],
};

/**
 * The only outcomes where "am I coming back today?" is a real question.
 *
 * A delivered parcel is settled and a refusal is final, so the flag would be
 * noise on either. Mirrors RETRY_TODAY_OUTCOMES on the server, which refuses
 * to store it on anything else.
 */
export const RETRY_TODAY_OUTCOMES: Outcome[] = [Outcome.NoAnswerCarded, Outcome.AccessFailure];

/**
 * Why a driver is proceeding with a barcode that is not the expected one.
 *
 * A closed list rather than free text: this is the field that has to stand up
 * months later in a dispute, and "wrong label" typed six different ways is not
 * something anyone can count. None of these block the attempt; the driver
 * chooses one and carries on.
 */
export const BARCODE_OVERRIDE_REASONS: string[] = [
  'Label damaged or unreadable',
  'Parcel relabelled by depot',
  'Multiple parcels for this stop',
  'Scanner misread, checked by hand',
  'Customer confirmed it is theirs',
];

/**
 * Compares a scanned barcode with what dispatch expected.
 *
 * Null when there is nothing to compare against: no expected value, or the
 * driver has not entered one. That is a different fact from a mismatch and the
 * server stores it as one, so it must not collapse to false here.
 *
 * Comparison ignores case and surrounding whitespace. A scanner that returns a
 * trailing newline, or a driver typing in lower case, is not a mismatch worth
 * interrupting someone at a doorstep for.
 */
export function barcodeMatches(
  expected: string | null | undefined,
  scanned: string | null | undefined,
): boolean | null {
  const a = expected?.trim().toUpperCase();
  const b = scanned?.trim().toUpperCase();
  if (!a || !b) return null;
  return a === b;
}

export interface EvidenceInput {
  hasSignature: boolean;
  photoCount: number;
  reasonCode: string | null;
  neighbourHouseNumber: string | null;
}

/** Empty array = ready to submit. Same contract as the server's validator. */
export function validateEvidence(outcome: Outcome, input: EvidenceInput): string[] {
  const spec = OUTCOME_SPECS[outcome];
  const violations: string[] = [];

  if (spec.signature === 'required' && !input.hasSignature) violations.push('Signature needed');
  if (spec.signature === 'forbidden' && input.hasSignature) violations.push('Signature not allowed here');
  if (input.photoCount < spec.photos.min) {
    violations.push(`At least ${spec.photos.min} photo${spec.photos.min > 1 ? 's' : ''} needed`);
  }
  if (input.photoCount > spec.photos.max) violations.push(`At most ${spec.photos.max} photos`);
  if (spec.reason === 'required' && !input.reasonCode) violations.push('Reason needed');
  if (spec.reason === 'forbidden' && input.reasonCode) violations.push('Reason not allowed here');
  if (spec.neighbourHouseNumber === 'required' && !input.neighbourHouseNumber) {
    violations.push("Neighbour's house number needed");
  }
  if (spec.neighbourHouseNumber === 'forbidden' && input.neighbourHouseNumber) {
    violations.push('House number not allowed here');
  }

  return violations;
}
