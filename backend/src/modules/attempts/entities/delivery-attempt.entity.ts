import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { AttemptSource, EvidenceStatus, Outcome } from '../../../domain/outcomes';

/**
 * The evidence table. Append-only: no UPDATE/DELETE surface in the API, and
 * the app's DB role only holds column-level UPDATE on the two bookkeeping
 * columns (evidence_status, updated_at) - see migration 003.
 */
@Entity('delivery_attempts')
export class DeliveryAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Client-generated idempotency key; the unique index is the cross-instance arbiter. */
  @Index('uq_attempts_client_attempt_id', { unique: true })
  @Column({ name: 'client_attempt_id', type: 'uuid' })
  clientAttemptId!: string;

  @Column({ name: 'stop_id', type: 'uuid' })
  stopId!: string;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId!: string | null;

  @Column({ name: 'parcel_barcode', type: 'text', nullable: true })
  parcelBarcode!: string | null;

  @Column({ name: 'barcode_source', type: 'text', nullable: true })
  barcodeSource!: 'scanned' | 'manual' | null;

  @Column({ type: 'text' })
  outcome!: Outcome;

  @Column({ name: 'signature_s3_key', type: 'text', nullable: true })
  signatureS3Key!: string | null;

  @Column({ name: 'signature_verified_at', type: 'timestamptz', nullable: true })
  signatureVerifiedAt!: Date | null;

  @Column({ name: 'signature_size_bytes', type: 'bigint', nullable: true })
  signatureSizeBytes!: string | null;

  @Column({ name: 'neighbour_house_number', type: 'text', nullable: true })
  neighbourHouseNumber!: string | null;

  @Column({ name: 'reason_code', type: 'text', nullable: true })
  reasonCode!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'double precision' })
  lat!: number;

  @Column({ type: 'double precision' })
  lng!: number;

  @Column({ name: 'gps_accuracy_m', type: 'real', nullable: true })
  gpsAccuracyM!: number | null;

  /** Device clock - may be days old for offline submissions. Never overwritten. */
  @Column({ name: 'captured_at', type: 'timestamptz' })
  capturedAt!: Date;

  /** Server clock - authoritative for ordering, cursors, and the live feed. */
  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt!: Date;

  @Column({ name: 'clock_suspect', type: 'boolean', default: false })
  clockSuspect!: boolean;

  @Column({ name: 'app_version', type: 'text' })
  appVersion!: string;

  @Column({ type: 'text', default: 'v2' })
  source!: AttemptSource;

  /** Exact client body for v1_compat/backfill rows - never destroy what was actually said. */
  @Column({ name: 'raw_payload', type: 'jsonb', nullable: true })
  rawPayload!: Record<string, unknown> | null;

  @Column({ name: 'declared_photo_count', type: 'smallint', default: 0 })
  declaredPhotoCount!: number;

  @Column({ name: 'evidence_status', type: 'text', default: 'pending_media' })
  evidenceStatus!: EvidenceStatus;

  /** sha256 of the canonical submit body; detects idempotency-key reuse with a different payload. */
  @Column({ name: 'payload_hash', type: 'text' })
  payloadHash!: string;

  /** Only moves when evidence_status moves - this is the delta-sync cursor column. */
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
