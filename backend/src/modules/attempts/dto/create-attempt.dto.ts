import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ALL_OUTCOMES, MAX_PHOTOS_PER_ATTEMPT, Outcome } from '../../../domain/outcomes';

export class DeclaredPhotoDto {
  @IsInt()
  @Min(0)
  @Max(MAX_PHOTOS_PER_ATTEMPT - 1)
  index!: number;

  /** Declared upfront so the presigned PUT can pin the exact length. */
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  sizeBytes!: number;
}

export class DeclaredSignatureDto {
  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024)
  sizeBytes!: number;
}

/**
 * Structural validation lives here; the cross-field evidence matrix
 * (which outcome requires which evidence) is enforced in the service via
 * domain/outcomes.ts so DTO and DB share one source of truth.
 */
export class CreateAttemptDto {
  @IsUUID(4)
  clientAttemptId!: string;

  @IsUUID(4)
  stopId!: string;

  @IsIn(ALL_OUTCOMES)
  outcome!: Outcome;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  parcelBarcode?: string;

  @ValidateIf((o: CreateAttemptDto) => o.parcelBarcode !== undefined)
  @IsIn(['scanned', 'manual'])
  barcodeSource?: 'scanned' | 'manual';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  neighbourHouseNumber?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  reasonCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsNumber()
  @IsLatitude()
  lat!: number;

  @IsNumber()
  @IsLongitude()
  lng!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  gpsAccuracyM?: number;

  /** Device clock at capture - may be days in the past for offline work. */
  @IsISO8601()
  capturedAt!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  appVersion!: string;

  @IsOptional()
  @Type(() => DeclaredPhotoDto)
  @ValidateNested({ each: true })
  photos?: DeclaredPhotoDto[];

  @IsOptional()
  @Type(() => DeclaredSignatureDto)
  @ValidateNested()
  signature?: DeclaredSignatureDto;
}
