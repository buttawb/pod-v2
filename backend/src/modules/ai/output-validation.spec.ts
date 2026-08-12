import { scrubNote, validateSummaryOutput } from './output-validation';

describe('AI output validation (nothing unvalidated reaches a customer)', () => {
  const rejects: Array<[string, string]> = [
    ['', 'empty'],
    ['INSUFFICIENT', 'model_declared_insufficient'],
    ['x'.repeat(141), 'too_long'],
    ['line one\nline two', 'multiline'],
    ['Left at SE15 4XX as requested.', 'contains_postcode'],
    ['Left at 42 Church Road with a neighbour.', 'contains_street_address'],
    ['Call 07911 123456 to arrange redelivery.', 'contains_phone'],
    ['Contact help@courier.com for details.', 'contains_email'],
    ['We guarantee redelivery tomorrow.', 'contains_banned_word'],
  ];

  it.each(rejects)('rejects %j as %s', (text, reason) => {
    expect(validateSummaryOutput(text)).toBe(reason);
  });

  it('accepts a clean one-line summary', () => {
    expect(
      validateSummaryOutput('Your parcel has been left in a safe place at your address.'),
    ).toBeNull();
  });

  /**
   * This assertion used to run the other way, accepting "left in a safe place
   * by the rear door" as clean output. It was the one case in the file that
   * pinned a leak as correct behaviour, so every later change was measured
   * against it and kept the leak.
   *
   * The recipient is entitled to know where their parcel is. The point is
   * that they should learn it in the app, behind authentication, and not from
   * a line that renders on a lock screen or lands in a shared mailbox where
   * whoever reads it is told where to find an unattended parcel.
   */
  const namesTheHidingPlace = [
    'Your parcel has been left in a safe place by the rear door.',
    'We left it behind the green bin for you.',
    'Your parcel is inside the porch.',
    'Left under the doormat as requested.',
    'Your delivery is in the shed.',
  ];

  it.each(namesTheHidingPlace)('refuses to tell a customer where it is hidden: %j', (text) => {
    expect(validateSummaryOutput(text)).toBe('names_safe_place');
  });

  it('does not mistake ordinary delivery language for a hiding place', () => {
    // Over-rejection costs a generic template, so this is not free: these all
    // have to keep passing or every handover summary degrades to boilerplate.
    expect(validateSummaryOutput('Handed to you at the door.')).toBeNull();
    expect(validateSummaryOutput('Your parcel was passed to a neighbour.')).toBeNull();
    expect(validateSummaryOutput('Nobody was in, so a card was left for you.')).toBeNull();
    expect(validateSummaryOutput('Your parcel has been left in a safe place.')).toBeNull();
  });

  it('scrubs phone numbers and emails from notes before they leave our system', () => {
    const scrubbed = scrubNote('ring 07911 123456 or mail joe@x.com, gate code 4');
    expect(scrubbed).not.toContain('07911');
    expect(scrubbed).not.toContain('joe@x.com');
    expect(scrubbed).toContain('gate code 4');
  });

  // The published policy says contact details are removed from the note, not
  // that the first one is. A single-occurrence test is what let a non-global
  // regex pass review, so every case here carries two.
  it('scrubs EVERY phone number and email, not just the first', () => {
    const scrubbed = scrubNote('call 07700 900123 or 07700 900456, or a@x.com, or b@y.com');
    expect(scrubbed).not.toContain('900123');
    expect(scrubbed).not.toContain('900456');
    expect(scrubbed).not.toContain('a@x.com');
    expect(scrubbed).not.toContain('b@y.com');
  });

  it('scrubs addresses and postcodes a driver typed into the note', () => {
    const scrubbed = scrubNote('tried 42 Church Road, SE15 4XX, then 7 Mill Lane, E14 2DY');
    expect(scrubbed).not.toContain('42 Church Road');
    expect(scrubbed).not.toContain('7 Mill Lane');
    expect(scrubbed).not.toContain('SE15 4XX');
    expect(scrubbed).not.toContain('E14 2DY');
  });

  it('leaves a note with nothing personal in it untouched', () => {
    const note = 'left round the back by the green bin';
    expect(scrubNote(note)).toBe(note);
  });

  it('validates consistently when called repeatedly', () => {
    // A global regex would advance lastIndex between calls and flip this.
    const text = 'Call 07911 123456 to arrange redelivery.';
    expect(validateSummaryOutput(text)).toBe('contains_phone');
    expect(validateSummaryOutput(text)).toBe('contains_phone');
  });
});
