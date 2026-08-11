import { Outcome } from '../../domain/outcomes';

/**
 * Deterministic fallbacks used whenever Bedrock is down, slow, or its output
 * fails validation. The driver's note text is deliberately NOT used here:
 * no summarization without the model, only safe canned text per outcome.
 */
export const FALLBACK_TEMPLATES: Record<Outcome, string> = {
  [Outcome.DeliveredToPerson]: 'Delivered and signed for by the recipient.',
  [Outcome.LeftWithNeighbour]: 'Delivered to a neighbour.',
  [Outcome.LeftSafePlace]: 'Delivered and left in your chosen safe place.',
  [Outcome.NoAnswerCarded]: 'We attempted delivery but no one was available. A card has been left.',
  [Outcome.Refused]: 'Delivery was refused and the parcel is being returned.',
  [Outcome.AccessFailure]: 'We could not access the delivery address. We will try again.',
};
