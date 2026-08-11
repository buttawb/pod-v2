import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class DriverLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  employeeRef!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  deviceFingerprint!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

export class OfficeLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken!: string;
}
