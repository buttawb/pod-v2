/**
 * The single source of truth for attempt outcomes and their evidence rules.
 * DTO validation, service-layer checks, and DB CHECK constraints all derive
 * from this file - change it here or nowhere.
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

export const ALL_OUTCOMES = Object.values(Outcome);

export interface EvidenceRule {
  signature: 'required' | 'forbidden';
  photos: { min: number; max: number };
  reason: 'required' | 'optional' | 'forbidden';
  neighbourHouseNumber: 'required' | 'forbidden';
}

export const MAX_PHOTOS_PER_ATTEMPT = 4;

export const EVIDENCE_RULES: Record<Outcome, EvidenceRule> = {
  [Outcome.DeliveredToPerson]: {
    signature: 'required',
    photos: { min: 0, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.LeftWithNeighbour]: {
    signature: 'forbidden',
    photos: { min: 1, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'required',
  },
  [Outcome.LeftSafePlace]: {
    // The photo IS the proof.
    signature: 'forbidden',
    photos: { min: 1, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.NoAnswerCarded]: {
    signature: 'forbidden',
    photos: { min: 1, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'forbidden',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.Refused]: {
    signature: 'forbidden',
    photos: { min: 0, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'required',
    neighbourHouseNumber: 'forbidden',
  },
  [Outcome.AccessFailure]: {
    signature: 'forbidden',
    photos: { min: 0, max: MAX_PHOTOS_PER_ATTEMPT },
    reason: 'required',
    neighbourHouseNumber: 'forbidden',
  },
};

/** Outcomes that settle the stop (drive the stops.status projection + legacy pods.delivered). */
export const DELIVERED_OUTCOMES: readonly Outcome[] = [
  Outcome.DeliveredToPerson,
  Outcome.LeftWithNeighbour,
  Outcome.LeftSafePlace,
];

export const StopStatus = {
  Pending: 'pending',
  Attempted: 'attempted',
  Delivered: 'delivered',
  Failed: 'failed',
} as const;

export type StopStatus = (typeof StopStatus)[keyof typeof StopStatus];

/**
 * stops.status projection from the latest attempt: delivered outcomes settle
 * the stop; refusal is final; no-answer/no-access mean "will retry".
 */
/**
 * The only outcomes where "am I coming back today?" is a real question.
 *
 * A delivered parcel is settled and a refusal is final, so a retry flag on
 * either would be noise the day list would then have to ignore. Carded and
 * no-access are the two where the outcome code genuinely cannot say whether
 * the stop is finished for the day.
 */
export const RETRY_TODAY_OUTCOMES: Outcome[] = [Outcome.NoAnswerCarded, Outcome.AccessFailure];

export const OUTCOME_TO_STOP_STATUS: Record<Outcome, StopStatus> = {
  [Outcome.DeliveredToPerson]: StopStatus.Delivered,
  [Outcome.LeftWithNeighbour]: StopStatus.Delivered,
  [Outcome.LeftSafePlace]: StopStatus.Delivered,
  [Outcome.NoAnswerCarded]: StopStatus.Attempted,
  [Outcome.Refused]: StopStatus.Failed,
  [Outcome.AccessFailure]: StopStatus.Attempted,
};

export const EvidenceStatus = {
  PendingMedia: 'pending_media',
  Complete: 'complete',
  IncompleteExpired: 'incomplete_expired',
} as const;

export type EvidenceStatus = (typeof EvidenceStatus)[keyof typeof EvidenceStatus];

export const AttemptSource = {
  V2: 'v2',
  V1Compat: 'v1_compat',
  Backfill: 'backfill',
} as const;

export type AttemptSource = (typeof AttemptSource)[keyof typeof AttemptSource];

export interface EvidenceInput {
  hasSignature: boolean;
  photoCount: number;
  reasonCode: string | null;
  neighbourHouseNumber: string | null;
}

/** Returns human-readable violations; empty array = evidence satisfies the outcome's rule. */
export function validateEvidence(outcome: Outcome, input: EvidenceInput): string[] {
  const rule = EVIDENCE_RULES[outcome];
  const violations: string[] = [];

  if (rule.signature === 'required' && !input.hasSignature) {
    violations.push(`${outcome} requires a signature`);
  }
  if (rule.signature === 'forbidden' && input.hasSignature) {
    violations.push(`${outcome} must not include a signature`);
  }
  if (input.photoCount < rule.photos.min) {
    violations.push(`${outcome} requires at least ${rule.photos.min} photo(s)`);
  }
  if (input.photoCount > rule.photos.max) {
    violations.push(`at most ${rule.photos.max} photos are allowed`);
  }
  if (rule.reason === 'required' && !input.reasonCode) {
    violations.push(`${outcome} requires a reason`);
  }
  if (rule.reason === 'forbidden' && input.reasonCode) {
    violations.push(`${outcome} must not include a reason`);
  }
  if (rule.neighbourHouseNumber === 'required' && !input.neighbourHouseNumber) {
    violations.push(`${outcome} requires the neighbour's house number`);
  }
  if (rule.neighbourHouseNumber === 'forbidden' && input.neighbourHouseNumber) {
    violations.push(`${outcome} must not include a neighbour house number`);
  }

  return violations;
}
