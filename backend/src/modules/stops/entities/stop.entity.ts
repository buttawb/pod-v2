import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { StopStatus } from '../../../domain/outcomes';

/**
 * v1 table, extended additively. The original v1 columns (driver_id, address,
 * postcode, location, sequence, created_at) must never change shape - the
 * legacy serializer and 14M existing rows depend on them.
 */
@Entity('stops')
export class Stop {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ type: 'text' })
  address!: string;

  @Column({ type: 'text' })
  postcode!: string;

  /** Legacy "lat,lng" string, e.g. "51.5074,-0.1278". Still written for v1 readers. */
  @Column({ type: 'varchar' })
  location!: string;

  @Column({ type: 'int' })
  sequence!: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  // ---- v2 additive columns (expand phase) ----

  @Column({ type: 'text', default: 'pending' })
  status!: StopStatus;

  @Column({ name: 'latest_attempt_id', type: 'uuid', nullable: true })
  latestAttemptId!: string | null;

  @Column({ type: 'double precision', nullable: true })
  lat!: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng!: number | null;

  /**
   * What dispatch says should be at this door. Additive on the v1 table; the
   * legacy serializer is a field whitelist, so it cannot reach the frozen v1
   * response.
   */
  @Column({ name: 'expected_barcode', type: 'text', nullable: true })
  expectedBarcode!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
