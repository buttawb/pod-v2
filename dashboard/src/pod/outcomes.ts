/** Mirrors the server's outcome vocabulary (backend/src/domain/outcomes.ts). */
export const OUTCOME_LABELS: Record<string, string> = {
  delivered_to_person: 'Delivered to person',
  left_with_neighbour: 'Left with neighbour',
  left_safe_place: 'Left in safe place',
  no_answer_carded: 'No answer / carded',
  refused: 'Refused',
  access_failure: 'Access failure',
};

export const DELIVERED_OUTCOMES = new Set([
  'delivered_to_person',
  'left_with_neighbour',
  'left_safe_place',
]);
