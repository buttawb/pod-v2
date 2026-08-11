import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Keyed by sha256(normalize(note) | outcome | PROMPT_VERSION). Driver notes repeat heavily. */
@Entity('ai_summary_cache')
export class AiSummaryCache {
  @PrimaryColumn({ name: 'cache_key', type: 'char', length: 64 })
  cacheKey!: string;

  @Column({ name: 'summary_text', type: 'text' })
  summaryText!: string;

  @Column({ type: 'text' })
  model!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
