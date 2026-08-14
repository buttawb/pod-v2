import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * auth.controller.ts describes these three bodies again as explicit @ApiBody
 * schemas, and that is what Swagger actually renders for the login routes.
 * The decorators here are still worth carrying: they keep the class readable
 * next to its validators, and they are what any other route that ever takes
 * one of these bodies would render from. Both copies quote the same examples
 * and the same maxLength values as the validators below, so if a rule here
 * changes, the schema in the controller has to change with it.
 */
export class DriverLoginDto {
  @ApiProperty({
    description:
      "The driver's employee reference, the same one printed on their badge. Case sensitive. " +
      'Use EMP-TEST-001 for the London round of 151 stops, or EMP-PK-001 for the Karachi ' +
      'round of 40 stops.',
    example: 'EMP-TEST-001',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  employeeRef!: string;

  @ApiProperty({
    description:
      'Password for that driver. Both seeded demo drivers share this one, deliberately, so ' +
      'there is a single credential to remember when demonstrating either round. It is a ' +
      'demo account on a demo database, published so this page can be run as it stands.',
    example: 'TestDriver#2026',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;

  @ApiProperty({
    description:
      'A stable identifier for the handset. The real app sends a per-install id; from Swagger ' +
      'any constant string works, and reusing the same one means repeat logins register as ' +
      'one device rather than a new one each time.',
    example: 'swagger-ui-demo',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  deviceFingerprint!: string;

  @ApiPropertyOptional({
    description:
      'Version of the app doing the signing in, recorded against the device so the fleet can ' +
      'be told apart by release. Optional: leave it out and the device is still registered.',
    example: '2.0.0',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

export class OfficeLoginDto {
  @ApiProperty({
    description:
      'Email address of the office user. Validated as a real email address, unlike the v1 ' +
      'login, and matched case insensitively so OFFICE@DEMO.POD works too.',
    example: 'office@demo.pod',
    format: 'email',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    description:
      'Password for that office user. This is a demo account seeded for the evaluation and ' +
      'guards nothing real, so it is printed here on purpose rather than hidden.',
    example: 'OfficeDemo#2026',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({
    description:
      'The opaque refreshToken string returned by POST /api/v2/auth/driver/login or ' +
      'POST /api/v2/auth/office/login. Single use: every successful refresh replaces it. ' +
      'There is no working example to pre-fill here because the value only exists once you ' +
      'have signed in, so paste your own before executing.',
    example: 'JmT2xQ8bqk1nR5vXpL0dYw3Zc7hAeK9sUgN4iOb6MfCtRlWvSyD1zHjEuQaPnBkX',
    maxLength: 256,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken!: string;
}
