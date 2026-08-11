import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const PhotoStatus = {
  AwaitingUpload: 'awaiting_upload',
  Verified: 'verified',
  DeletedRetention: 'deleted_retention',
} as const;

export type PhotoStatus = (typeof PhotoStatus)[keyof typeof PhotoStatus];

/**
 * The media manifest: one row per photo the client DECLARED at submit time.
 * A row exists before its bytes do - that is what lets the server know what
 * evidence it is owed. Verification (S3 HeadObject at finalize) flips status.
 */
@Entity('attempt_photos')
@Index('uq_attempt_photos_attempt_index', ['attemptId', 'photoIndex'], { unique: true })
export class AttemptPhoto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'attempt_id', type: 'uuid' })
  attemptId!: string;

  @Column({ name: 'photo_index', type: 'smallint' })
  photoIndex!: number;

  @Column({ name: 's3_key', type: 'text' })
  s3Key!: string;

  @Column({ name: 'content_type', type: 'text', default: 'image/jpeg' })
  contentType!: string;

  /** Client-declared at submit; verified against S3 at finalize. */
  @Column({ name: 'declared_size_bytes', type: 'bigint', nullable: true })
  declaredSizeBytes!: string | null;

  @Column({ name: 'size_bytes', type: 'bigint', nullable: true })
  sizeBytes!: string | null;

  @Column({ type: 'text', nullable: true })
  etag!: string | null;

  @Column({ type: 'text', default: 'awaiting_upload' })
  status!: PhotoStatus;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
