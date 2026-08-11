import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const AiSummaryStatus = {
  Pending: 'pending',
  Ready: 'ready',
  Fallback: 'fallback',
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
