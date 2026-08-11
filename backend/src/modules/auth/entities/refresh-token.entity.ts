import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const RefreshTokenStatus = {
  Active: 'active',
  Rotated: 'rotated',
  Revoked: 'revoked',
} as const;

export type RefreshTokenStatus = (typeof RefreshTokenStatus)[keyof typeof RefreshTokenStatus];

/**
 * Rotating refresh tokens with family-based reuse detection.
 * A rotated token replayed within the grace window returns its successor
 * (lost-response recovery); replayed after the window, the whole family is
 * revoked (theft containment for devices that live in vans).
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_refresh_tokens_hash', { unique: true })
  @Column({ name: 'token_hash', type: 'text' })
  tokenHash!: string;

  @Column({ name: 'family_id', type: 'uuid' })
  familyId!: string;

  /** Exactly one of driver_id / office_user_id is set. */
  @Column({ name: 'driver_id', type: 'uuid', nullable: true })
  driverId!: string | null;

  @Column({ name: 'office_user_id', type: 'uuid', nullable: true })
  officeUserId!: string | null;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId!: string | null;

  @Column({ type: 'text', default: 'active' })
  status!: RefreshTokenStatus;

  /** Set when rotated; grace-window checks compare against this. */
  @Column({ name: 'rotated_at', type: 'timestamptz', nullable: true })
  rotatedAt!: Date | null;

  /** The token that superseded this one, returned during the grace window. */
  @Column({ name: 'successor_id', type: 'uuid', nullable: true })
  successorId!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
