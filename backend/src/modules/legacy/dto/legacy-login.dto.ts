import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({
    description:
      "The driver's v1 identity, which is their employee reference lowercased with @fleet.local appended. It is a lookup key rather than a mailbox, so it is not validated as an email address: a stricter check would reject the fleet's own logins. Matched case insensitively.",
    example: 'emp-test-001@fleet.local',
    maxLength: 320,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    description:
      'The same password the driver uses on v2. v1 and v2 share the driver identity store, so credentials never fork; only the tokens they hand back differ.',
    example: 'TestDriver#2026',
    maxLength: 256,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}
