import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import CircuitBreaker from 'opossum';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { Outcome } from '../../domain/outcomes';
import {
  ATTEMPT_CREATED_EVENT,
  type AttemptCreatedEvent,
} from '../attempts/attempts.service';
import { AiSummary, AiSummarySource, AiSummaryStatus } from './entities/ai-summary.entity';
import { AiSummaryCache } from './entities/ai-summary-cache.entity';
import { FALLBACK_TEMPLATES } from './templates';
import { scrubNote, validateSummaryOutput } from './output-validation';

/**
 * Bump this whenever SYSTEM_PROMPT changes. It is part of the cache key, so
 * leaving it alone would keep serving text generated under the old prompt:
 * v1 was allowed to name the hiding place, and those summaries are cached.
 */
const PROMPT_VERSION = 'v2';
const MAX_CONCURRENT_GENERATIONS = 4;
const RETRY_BASE_DELAY_MS = 250;
const MEMORY_CACHE_MAX = 10_000;

// Claude Haiku 4.5 on Bedrock, rough partner pricing per million tokens.
const USD_PER_INPUT_MTOK = 1;
const USD_PER_OUTPUT_MTOK = 5;

const SYSTEM_PROMPT = `You rewrite a courier's internal delivery note into one short sentence suitable for the parcel's recipient.
Rules: maximum 140 characters; exactly one line; plain, friendly English; never include names, house numbers, street names, postcodes, phone numbers, or times; never speculate beyond the note; never make promises such as redelivery times; if the note is empty or unusable, output exactly INSUFFICIENT.
Never name the specific hiding place for a parcel left unattended. Say that it was left in a safe place, not which bin, shed, porch, doorway or container it is behind or inside. The recipient is told the exact location through the authenticated app, never in a message that can be read from a lock screen or a shared mailbox.`;

interface BedrockResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Failure isolation, outermost to innermost:
 * semaphore (bounded concurrency) -> circuit breaker (stop calling a dead
 * or throttled provider) -> 1 retry with jitter -> 3s hard timeout via
 * AbortController -> output validation -> template fallback.
 * The driver-facing submission path has zero coupling to any of this: it
 * emits an event and returns.
 */
@Injectable()
export class AiSummaryService {
  private readonly logger = new Logger(AiSummaryService.name);
  private readonly bedrock: BedrockRuntimeClient;
  private readonly breaker: CircuitBreaker<[string, Outcome], BedrockResult>;
  private readonly memoryCache = new Map<string, string>();
  private readonly enabled: boolean;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    @InjectRepository(AiSummary) private readonly summaries: Repository<AiSummary>,
    @InjectRepository(AiSummaryCache) private readonly cache: Repository<AiSummaryCache>,
    private readonly config: ConfigService,
  ) {
    this.enabled = this.config.get<boolean>('AI_ENABLED', true);
    this.modelId = this.config.getOrThrow<string>('BEDROCK_MODEL_ID');
    // 3s cut off legitimate slow-but-fine generations and spent the retry
    // budget on them, so a transient tail turned into a template. Nothing
    // waits on this call (the driver's submit path emits an event and
    // returns), so the only cost of waiting longer is a summary appearing a
    // couple of seconds later in the office.
    this.timeoutMs = this.config.get<number>('AI_TIMEOUT_MS', 5000);
    this.bedrock = new BedrockRuntimeClient({
      region: this.config.getOrThrow<string>('AWS_REGION'),
      maxAttempts: 1, // our retry layer is the only one; SDK retries would multiply worst-case latency
    });
    this.breaker = new CircuitBreaker(
      (note: string, outcome: Outcome) => this.invokeWithRetry(note, outcome),
      {
        timeout: false, // we own the timeout via AbortController
        errorThresholdPercentage: 50,
        rollingCountTimeout: 30_000,
        volumeThreshold: 10,
        resetTimeout: 60_000,
      },
    );
  }

  @OnEvent(ATTEMPT_CREATED_EVENT, { async: true })
  async onAttemptCreated(event: AttemptCreatedEvent): Promise<void> {
    await this.withSlot(async () => {
      try {
        await this.generate(event.attemptId, event.outcome as Outcome, event.note);
      } catch (err) {
        // generate() converts provider failures into a template itself, so
        // reaching here means the store failed, not the model. That used to
        // leave the row on `pending` forever, which the office reads as
        // "generating" and which never resolves.
        await this.storeFailed(event.attemptId, err);
        throw err;
      }
    });
  }

  async getSummary(attemptId: string) {
    const summary = await this.summaries.findOne({ where: { attemptId } });
    // Same keys whether or not a row exists. This branch used to return two
    // keys and nothing else, so a consumer reading `source` to tell a model
    // draft from a template got `undefined` here and had no way to know
    // whether that meant "template" or "no summary at all".
    if (!summary) {
      return {
        attemptId,
        status: 'none',
        draft: null,
        source: null,
        model: null,
        finalText: null,
        editedBy: null,
        editedAt: null,
        sentAt: null,
        generatedAt: null,
      };
    }
    return this.serialize(summary);
  }

  async regenerate(attemptId: string) {
    const summary = await this.summaries.findOne({ where: { attemptId } });
    const attempt = await this.summaries.manager.query(
      `SELECT outcome, note FROM delivery_attempts WHERE id = $1`,
      [attemptId],
    ) as Array<{ outcome: Outcome; note: string | null }>;
    if (attempt.length === 0) throw new NotFoundException('Unknown attempt');
    if (summary?.sentAt) return this.serialize(summary); // sent text is settled

    await this.generate(attemptId, attempt[0].outcome, attempt[0].note, { skipCache: true });
    const fresh = await this.summaries.findOneOrFail({ where: { attemptId } });
    return this.serialize(fresh);
  }

  /** The AI draft column is immutable; edits land in finalText with attribution. */
  async editFinal(attemptId: string, officeUserId: string, finalText: string) {
    const summary = await this.summaries.findOne({ where: { attemptId } });
    if (!summary) throw new NotFoundException('No summary for attempt');
    await this.summaries.update(
      { id: summary.id },
      { finalText, editedBy: officeUserId, editedAt: new Date() },
    );
    return this.serialize(await this.summaries.findOneOrFail({ where: { id: summary.id } }));
  }

  /** A named human clicking Send IS the approval; unedited draft becomes the final text. */
  async markSent(attemptId: string, officeUserId: string) {
    const summary = await this.summaries.findOne({ where: { attemptId } });
    if (!summary || !summary.draftText) throw new NotFoundException('Nothing to send');
    await this.summaries.update(
      { id: summary.id },
      {
        // A named human clicking Send is the approval, and the record has to
        // say so: `ready` only ever meant "the model produced something that
        // validated", which is not the same claim as "a person stands behind
        // this text".
        status: AiSummaryStatus.Approved,
        finalText: summary.finalText ?? summary.draftText,
        editedBy: summary.editedBy ?? officeUserId,
        sentAt: new Date(),
      },
    );
    return this.serialize(await this.summaries.findOneOrFail({ where: { id: summary.id } }));
  }

  private async generate(
    attemptId: string,
    outcome: Outcome,
    note: string | null,
    opts: { skipCache?: boolean } = {},
  ): Promise<void> {
    await this.summaries.upsert(
      { attemptId, status: AiSummaryStatus.Pending },
      { conflictPaths: ['attemptId'], skipUpdateIfNoValuesChanged: true },
    );

    if (!note || note.trim().length === 0 || !this.enabled) {
      await this.storeFallback(attemptId, outcome, note ? 'ai_disabled' : 'empty_note');
      return;
    }

    const scrubbed = scrubNote(note);
    const cacheKey = this.cacheKey(scrubbed, outcome);

    if (!opts.skipCache) {
      const cached = this.memoryCache.get(cacheKey) ?? (await this.readDbCache(cacheKey));
      if (cached) {
        await this.storeReady(attemptId, cached, { cacheHit: true, inputTokens: 0, outputTokens: 0 });
        return;
      }
    }

    const startedAt = Date.now();
    try {
      const result = await this.breaker.fire(scrubbed, outcome);
      const rejection = validateSummaryOutput(result.text);
      if (rejection) {
        this.logCall(outcome, startedAt, result, false, `rejected:${rejection}`);
        await this.storeFallback(attemptId, outcome, rejection);
        return;
      }
      const text = result.text.trim();
      await this.writeCache(cacheKey, text);
      await this.storeReady(attemptId, text, {
        cacheHit: false,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      this.logCall(outcome, startedAt, result, false, 'ok');
    } catch (err) {
      this.logCall(outcome, startedAt, null, this.breaker.opened, (err as Error).message);
      await this.storeFallback(attemptId, outcome, 'provider_failure');
    }
  }

  private async invokeWithRetry(note: string, outcome: Outcome): Promise<BedrockResult> {
    try {
      return await this.invokeOnce(note, outcome);
    } catch (err) {
      // One retry, only for transient classes; a validation-style error from
      // the SDK would repeat identically and deserves no second attempt.
      const name = (err as Error).name;
      const retryable =
        name === 'AbortError' ||
        name === 'ThrottlingException' ||
        name === 'ServiceUnavailableException' ||
        name === 'InternalServerException' ||
        name === 'ModelNotReadyException';
      if (!retryable) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS + Math.random() * RETRY_BASE_DELAY_MS));
      return this.invokeOnce(note, outcome);
    }
  }

  private async invokeOnce(note: string, outcome: Outcome): Promise<BedrockResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.bedrock.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [
            { role: 'user', content: [{ text: `Outcome: ${outcome}\nDriver note: "${note}"` }] },
          ],
          // No stopSequences: Bedrock rejects whitespace-only stops; the
          // single-line rule is enforced by validateSummaryOutput instead.
          inferenceConfig: { maxTokens: 80, temperature: 0 },
        }),
        { abortSignal: controller.signal },
      );
      const text =
        response.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
      return {
        text,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async storeReady(
    attemptId: string,
    text: string,
    meta: { cacheHit: boolean; inputTokens: number; outputTokens: number },
  ): Promise<void> {
    await this.summaries.update(
      { attemptId },
      {
        status: AiSummaryStatus.Ready,
        draftText: text,
        source: AiSummarySource.Bedrock,
        model: this.modelId,
        promptVersion: PROMPT_VERSION,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        estCostUsd: this.estimateCost(meta.inputTokens, meta.outputTokens).toFixed(6),
        generatedAt: new Date(),
      },
    );
  }

  private async storeFallback(attemptId: string, outcome: Outcome, reason: string): Promise<void> {
    await this.summaries.update(
      { attemptId },
      {
        status: AiSummaryStatus.Fallback,
        draftText: FALLBACK_TEMPLATES[outcome],
        source: AiSummarySource.Template,
        model: null,
        promptVersion: PROMPT_VERSION,
        generatedAt: new Date(),
      },
    );
    this.logger.log(
      JSON.stringify({ event: 'ai_fallback', outcome, reason, breakerOpen: this.breaker.opened }),
    );
  }

  /**
   * The end of the line: no model draft and no template either.
   *
   * Best-effort by design. If this write fails too there is nothing further
   * to try, and throwing here would replace a bad status with a lost one.
   */
  private async storeFailed(attemptId: string, err: unknown): Promise<void> {
    await this.summaries
      .update({ attemptId }, { status: AiSummaryStatus.Failed, generatedAt: new Date() })
      .catch(() => undefined);
    this.logger.error(
      JSON.stringify({
        event: 'ai_failed',
        attemptId,
        reason: err instanceof Error ? err.message : 'unknown',
      }),
    );
  }

  private async readDbCache(cacheKey: string): Promise<string | null> {
    const hit = await this.cache.findOne({ where: { cacheKey } });
    if (hit) this.rememberInMemory(cacheKey, hit.summaryText);
    return hit?.summaryText ?? null;
  }

  private async writeCache(cacheKey: string, text: string): Promise<void> {
    this.rememberInMemory(cacheKey, text);
    await this.cache.upsert(
      { cacheKey, summaryText: text, model: this.modelId },
      { conflictPaths: ['cacheKey'], skipUpdateIfNoValuesChanged: true },
    );
  }

  private rememberInMemory(key: string, value: string): void {
    if (this.memoryCache.size >= MEMORY_CACHE_MAX) {
      const oldest = this.memoryCache.keys().next().value;
      if (oldest !== undefined) this.memoryCache.delete(oldest);
    }
    this.memoryCache.set(key, value);
  }

  private cacheKey(note: string, outcome: Outcome): string {
    const normalized = note.toLowerCase().replace(/\s+/g, ' ').trim();
    return createHash('sha256')
      .update(`${normalized}|${outcome}|${PROMPT_VERSION}`)
      .digest('hex');
  }

  private estimateCost(inputTokens: number, outputTokens: number): number {
    return (inputTokens * USD_PER_INPUT_MTOK + outputTokens * USD_PER_OUTPUT_MTOK) / 1_000_000;
  }

  private logCall(
    outcome: Outcome,
    startedAt: number,
    result: BedrockResult | null,
    breakerOpen: boolean,
    status: string,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'ai_call',
        model: this.modelId,
        outcome,
        status,
        latencyMs: Date.now() - startedAt,
        inputTokens: result?.inputTokens ?? null,
        outputTokens: result?.outputTokens ?? null,
        estCostUsd: result ? this.estimateCost(result.inputTokens, result.outputTokens) : null,
        breakerOpen,
        promptVersion: PROMPT_VERSION,
      }),
    );
  }

  /** Tiny semaphore: at most N generations in flight, the rest queue in-process. */
  private async withSlot(fn: () => Promise<void>): Promise<void> {
    if (this.active >= MAX_CONCURRENT_GENERATIONS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Summary generation failed: ${(err as Error).message}`);
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private serialize(summary: AiSummary) {
    return {
      attemptId: summary.attemptId,
      status: summary.status,
      draft: summary.draftText,
      source: summary.source,
      model: summary.model,
      finalText: summary.finalText,
      editedBy: summary.editedBy,
      editedAt: summary.editedAt,
      sentAt: summary.sentAt,
      generatedAt: summary.generatedAt,
    };
  }
}
