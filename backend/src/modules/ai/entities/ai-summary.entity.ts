import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Four outcomes, not two, because an office user needs to know which one they
 * are looking at before they send it to a customer.
 *
 * `ready` is a model draft that passed validation. `fallback` is the
 * deterministic template for the outcome: still safe to send, but nobody
 * wrote it about this delivery, so it says nothing the outcome code did not
 * already say. `failed` is the honest answer when even the fallback could not
 * be stored: the row used to sit on `pending` forever in that case, which
 * reads on screen as "still working on it" and never resolves. `approved` is
 * set when a named human has signed off, which is what actually authorises
 * sending it.
 *
 * `source` answers a different question (`bedrock` vs `template`) and both are
 * exposed, because "the AI wrote this" and "a human approved this" are
 * independent facts and collapsing them would let a template be presented as
 * a model draft.
 *
 * Stored in a plain text column, so adding a value needs no migration.
 */
export const AiSummaryStatus = {
  Pending: 'pending',
  Ready: 'ready',
  Fallback: 'fallback',
  Failed: 'failed',
  Approved: 'approved',
} as const;

export type AiSummaryStatus = (typeof AiSummaryStatus)[keyof typeof AiSummaryStatus];

export const AiSummarySource = {
  Bedrock: 'bedrock',
  Template: 'template',
} as const;

export type AiSummarySource = (typeof AiSummarySource)[keyof typeof AiSummarySource];

/**
 * The AI draft is immutable once generated; office edits land in finalText.
 * Keeping both gives an audit trail and a labeled eval corpus.
 */
@Entity('ai_summaries')
export class AiSummary {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_ai_summaries_attempt', { unique: true })
  @Column({ name: 'attempt_id', type: 'uuid' })
  attemptId!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: AiSummaryStatus;

  @Column({ name: 'draft_text', type: 'text', nullable: true })
  draftText!: string | null;

  @Column({ type: 'text', nullable: true })
  source!: AiSummarySource | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ name: 'prompt_version', type: 'text', nullable: true })
  promptVersion!: string | null;

  @Column({ name: 'input_tokens', type: 'int', nullable: true })
  inputTokens!: number | null;

  @Column({ name: 'output_tokens', type: 'int', nullable: true })
  outputTokens!: number | null;

  @Column({ name: 'est_cost_usd', type: 'numeric', precision: 10, scale: 6, nullable: true })
  estCostUsd!: string | null;

  @Column({ name: 'generated_at', type: 'timestamptz', nullable: true })
  generatedAt!: Date | null;

  @Column({ name: 'final_text', type: 'text', nullable: true })
  finalText!: string | null;

  @Column({ name: 'edited_by', type: 'uuid', nullable: true })
  editedBy!: string | null;

  @Column({ name: 'edited_at', type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}
