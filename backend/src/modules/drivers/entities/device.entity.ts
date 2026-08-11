import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Identified by a client-generated install ID - never IMEI or serial. */
@Entity('devices')
export class Device {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'device_fingerprint', type: 'text', unique: true })
  deviceFingerprint!: string;

  @Column({ type: 'text', default: 'android' })
  platform!: string;

  @Column({ name: 'last_seen_app_version', type: 'text', nullable: true })
  lastSeenAppVersion!: string | null;

  @Column({ name: 'first_seen_at', type: 'timestamptz', default: () => 'now()' })
  firstSeenAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'now()' })
  lastSeenAt!: Date;
}
