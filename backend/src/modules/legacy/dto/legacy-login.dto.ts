import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Frozen alongside the rest of the v1 surface: shape changes break handsets. */
export class LegacyLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  employeeRef!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}
