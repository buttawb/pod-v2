const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const STREET_ADDRESS = /\b\d{1,4}\s+\w+\s+(road|street|st|ave|avenue|lane|close|drive|way|court|crescent)\b/i;
const PHONE = /(\+?\d[\d\s().-]{8,}\d)/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const BANNED_WORDS = /\b(guarantee|guaranteed|refund|compensation|lawsuit|liable)\b/i;

/**
 * A named hiding place for an unattended parcel.
 *
 * The prompt already forbids this, but a prompt is a request and this is the
 * last thing between the model and a customer, so it is enforced here too.
 * The risk is not that the recipient learns where their parcel is: they need
 * to know, and the app tells them behind authentication. It is that this text
 * goes out over channels that are readable without it, on a lock screen or in
 * a shared mailbox, and a thief who reads it is told exactly where to look.
 *
 * Deliberately narrow: a placement preposition immediately before a container
 * word. That is what makes "left it behind the green bin" a rejection while
 * "handed to you at the door" is not, and a false rejection is cheap anyway
 * since it routes to the generic template rather than dropping the summary.
 */
const NAMED_SAFE_PLACE =
  /\b(in|inside|behind|under|underneath|beside|by|next to|round the back of)\s+(the\s+|a\s+|your\s+)?(?:\w+\s+)?(bin|bins|wheelie bin|shed|porch|greenhouse|garage|carport|conservatory|meter box|letterbox|mailbox|post box|plant pot|planter|flower pot|doorstep|doormat|mat|gate|fence|hedge|bush|rear door|back door|side door|front door|window|recycling box|coal bunker|log store|bike store|caravan|summerhouse|outhouse)\b/i;

/**
 * Scrubbing needs every match; validation needs only to know whether one
 * exists. Kept as separate literals rather than adding /g above, because
 * `RegExp.test` with a global pattern advances lastIndex between calls and
 * would make validateSummaryOutput flap on alternate invocations.
 */
const SCRUB_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(EMAIL.source, 'gi'), '[email removed]'],
  [new RegExp(PHONE.source, 'gi'), '[number removed]'],
  [new RegExp(UK_POSTCODE.source, 'gi'), '[postcode removed]'],
  [new RegExp(STREET_ADDRESS.source, 'gi'), '[address removed]'],
];

export const MAX_SUMMARY_CHARS = 140;
export const INSUFFICIENT_SENTINEL = 'INSUFFICIENT';

/**
 * The model's output is never surfaced unvalidated, and even validated
 * output is only a draft for human review. Any rejection here routes to the
 * template fallback and a structured log for prompt tuning.
 */
export function validateSummaryOutput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed === INSUFFICIENT_SENTINEL) return 'model_declared_insufficient';
  if (trimmed.length > MAX_SUMMARY_CHARS) return 'too_long';
  if (trimmed.includes('\n')) return 'multiline';
  if (UK_POSTCODE.test(trimmed)) return 'contains_postcode';
  if (STREET_ADDRESS.test(trimmed)) return 'contains_street_address';
  if (PHONE.test(trimmed)) return 'contains_phone';
  if (EMAIL.test(trimmed)) return 'contains_email';
  if (BANNED_WORDS.test(trimmed)) return 'contains_banned_word';
  if (NAMED_SAFE_PLACE.test(trimmed)) return 'names_safe_place';
  return null;
}

/**
 * Strip personal data from the note before it ever leaves our system.
 *
 * The note is the one free-text field the model sees, so it is the only way
 * an address, a postcode or a contact detail could reach the provider at all:
 * every other field we send is a closed outcome code. The published privacy
 * policy states plainly that none of those reach it, so this function is what
 * makes that sentence true, and every occurrence has to go, not just the
 * first. Email is matched before phone, since an address like
 * "sam@0800-123-4567.example" would otherwise be half-eaten by the phone
 * pattern and left recognisable.
 */
export function scrubNote(note: string): string {
  return SCRUB_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    note,
  ).slice(0, 500);
}
