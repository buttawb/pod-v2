import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Frozen with the rest of the v1 surface. The global validation pipe runs
 * with forbidNonWhitelisted, so this class IS the accepted request body: any
 * field renamed here is a 400 for every handset that cannot be updated.
 *
 * Not @IsEmail: v1 identities are synthesised as employeeRef@fleet.local and
 * a stricter validator would reject our own drivers. The value is a lookup
 * key, not a contact address.
 */
export class LegacyLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}
