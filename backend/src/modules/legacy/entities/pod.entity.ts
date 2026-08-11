import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * v1 table - FROZEN SHAPE. From Phase 2 onward this is a projection of the
 * latest terminal attempt per stop (pods.stop_id is UNIQUE: v1 only ever
 * stored "current state of the stop", never a timeline).
 */
@Entity('pods')
export class Pod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'stop_id', type: 'uuid', unique: true })
  stopId!: string;

  @Column({ type: 'boolean' })
  delivered!: boolean;

  @Column({ name: 'photo_url', type: 'text', nullable: true })
  photoUrl!: string | null;

  @Column({ name: 'signature_url', type: 'text', nullable: true })
  signatureUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  location!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
