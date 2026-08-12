import { ConfigService } from '@nestjs/config';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { Repository } from 'typeorm';
import { Outcome } from '../../domain/outcomes';
import { AiSummary } from './entities/ai-summary.entity';
import { AiSummaryCache } from './entities/ai-summary-cache.entity';
import { AiSummaryService } from './ai-summary.service';

/**
 * PRIVACY.md publishes a flat claim: the only things that reach Bedrock are
 * the driver's note and the outcome code, never an address, a postcode, a GPS
 * coordinate or a parcel identifier. Nothing in the type system holds that
 * line. One extra field spliced into the Converse input, or one extra line
 * appended to the prompt, would make the published sentence false and would
 * ship green. These pin the wire payload so that edit has to fail here first.
 */
describe('what actually reaches the model provider', () => {
  const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
  const MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

  // Clean, one line, no banned content, so validateSummaryOutput accepts it
  // and the happy path runs to completion. A rejected reply would still leave
  // `sent` populated, which could disguise a broken payload as a pass.
  const REPLY = {
    output: {
      message: {
        content: [{ text: 'Your parcel was left in your chosen safe place.' }],
      },
    },
    usage: { inputTokens: 40, outputTokens: 12 },
  };

  const buildService = (attemptRows: Array<Record<string, unknown>> = []) => {
    const stored = {
      id: 'summary-1',
      attemptId: ATTEMPT_ID,
      status: 'ready',
      draftText: REPLY.output.message.content[0].text,
      source: 'bedrock',
      model: MODEL_ID,
      finalText: null,
      editedBy: null,
      editedAt: null,
      sentAt: null,
      generatedAt: new Date(0),
    } as unknown as AiSummary;

    const summaries = {
      findOne: () => Promise.resolve(null),
      findOneOrFail: () => Promise.resolve(stored),
      upsert: () => Promise.resolve(undefined),
      update: () => Promise.resolve(undefined),
      manager: { query: () => Promise.resolve(attemptRows) },
    } as unknown as Repository<AiSummary>;

    const cache = {
      findOne: () => Promise.resolve(null),
      upsert: () => Promise.resolve(undefined),
    } as unknown as Repository<AiSummaryCache>;

    const config = {
      get: (_key: string, fallback: unknown) => fallback,
      getOrThrow: (key: string) => (key === 'BEDROCK_MODEL_ID' ? MODEL_ID : 'eu-west-2'),
    } as unknown as ConfigService;

    const service = new AiSummaryService(summaries, cache, config);

    // The client is built in the constructor, so the capturing double replaces
    // it afterwards. Keeping the real ConverseCommand means the object under
    // assertion is the one the SDK would have put on the wire.
    const sent: ConverseCommand[] = [];
    (
      service as unknown as {
        bedrock: { send: (command: ConverseCommand) => Promise<unknown> };
      }
    ).bedrock = {
      send: (command: ConverseCommand) => {
        sent.push(command);
        return Promise.resolve(REPLY);
      },
    };

    return { service, sent };
  };

  const userTextOf = (command: ConverseCommand): string =>
    command.input.messages?.[0]?.content?.[0]?.text ?? '';

  it('sends the outcome and the note, and nothing besides', async () => {
    const note = 'no one home, left a card through the letterbox';
    const { service, sent } = buildService();

    await service.onAttemptCreated({
      attemptId: ATTEMPT_ID,
      outcome: Outcome.NoAnswerCarded,
      note,
    });

    // Asserted before anything else: a path that never calls the provider
    // would otherwise satisfy every "must not contain" check below for free.
    expect(sent).toHaveLength(1);

    const input = sent[0].input;
    expect(Object.keys(input).sort()).toEqual([
      'inferenceConfig',
      'messages',
      'modelId',
      'system',
    ]);
    expect(input.modelId).toBe(MODEL_ID);
    expect(input.messages).toHaveLength(1);
    expect(input.messages?.[0]?.role).toBe('user');
    expect(input.messages?.[0]?.content).toHaveLength(1);

    // Anchored on both ends, so an extra prompt line carrying a stop
    // reference, an address or an ETA breaks the match instead of hiding
    // inside a substring check.
    const match = /^Outcome: (?<outcome>[a-z_]+)\nDriver note: "(?<note>[^"]*)"$/.exec(
      userTextOf(sent[0]),
    );
    expect(match).not.toBeNull();
    expect(match?.groups?.outcome).toBe(Outcome.NoAnswerCarded);
    expect(match?.groups?.note).toBe(note);
  });

  it('hands the provider a note with the phone, email, postcode and street address already removed', async () => {
    const note =
      'tried 42 Church Road, SE15 4XX, rang 07911 123456, emailed joe.bloggs@example.com, no answer';
    const { service, sent } = buildService();

    await service.onAttemptCreated({
      attemptId: ATTEMPT_ID,
      outcome: Outcome.NoAnswerCarded,
      note,
    });

    expect(sent).toHaveLength(1);
    const userText = userTextOf(sent[0]);

    expect(userText).not.toContain('42 Church Road');
    expect(userText).not.toContain('Church Road');
    expect(userText).not.toContain('SE15 4XX');
    expect(userText).not.toContain('SE15');
    expect(userText).not.toContain('07911');
    expect(userText).not.toContain('123456');
    expect(userText).not.toContain('joe.bloggs@example.com');
    expect(userText).not.toContain('joe.bloggs');

    // Scrubbing has to leave the useful half of the note behind. Without
    // this, sending an empty string would pass every assertion above.
    expect(userText).toContain('no answer');
  });

  it('carries no attempt, stop, driver, address or GPS identifier anywhere in the command', async () => {
    // regenerate is the path holding a whole delivery_attempts row, so it is
    // where a stray column would realistically get picked up and forwarded.
    // The row is poisoned with the real column set to prove the service reads
    // only outcome and note off it.
    const note = 'left round the back by the green bin';
    const identifiers = {
      id: ATTEMPT_ID,
      stop_id: '22222222-2222-4222-8222-222222222222',
      driver_id: '33333333-3333-4333-8333-333333333333',
      device_id: 'device-abc-999',
      parcel_barcode: 'JD0002234567890',
      address: '42 Church Road, London',
      postcode: 'SE15 4XX',
      gps_lat: '51.4712345',
      gps_lng: '-0.0678901',
    };
    const { service, sent } = buildService([
      { ...identifiers, outcome: Outcome.LeftSafePlace, note },
    ]);

    await service.regenerate(ATTEMPT_ID);

    expect(sent).toHaveLength(1);
    const serialized = JSON.stringify(sent[0]);

    for (const value of Object.values(identifiers)) {
      expect(serialized).not.toContain(value);
    }

    // Proves the haystack is a real serialized payload rather than an empty
    // string that would trivially satisfy the loop above.
    expect(serialized).toContain(Outcome.LeftSafePlace);
    expect(serialized).toContain(note);
  });
});
