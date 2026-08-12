import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Deliberately minimal PII: display name + payroll reference only.
 * No phone, no home address - data minimisation (see PRIVACY.md).
 */
@Entity('drivers')
export class Driver {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_ref', type: 'text', unique: true })
  employeeRef!: string;

  @Column({ name: 'display_name', type: 'text' })
  displayName!: string;

  /** How v1.4.2 signs in. Derived from employee_ref; see migration 0006. */
  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
