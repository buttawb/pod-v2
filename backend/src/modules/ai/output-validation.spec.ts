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
      validateSummaryOutput('Your parcel has been left in a safe place by the rear door.'),
    ).toBeNull();
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
