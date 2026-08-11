import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The exact v1 POST body: { delivered, photo_url, signature_url, location, note }.
 * snake_case field names are part of the frozen contract.
 */
export class LegacyPodDto {
  @IsBoolean()
  delivered!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  photo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  signature_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
