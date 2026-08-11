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
  });
});
