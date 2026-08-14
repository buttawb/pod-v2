import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

export class DeclaredPhotoDto {
  @ApiProperty({
    example: 0,
    minimum: 0,
    maximum: MAX_PHOTOS_PER_ATTEMPT - 1,
    description:
      `Position of this photo within the attempt, 0 to ${MAX_PHOTOS_PER_ATTEMPT - 1}. ` +
      'Indexes must be unique inside one attempt: repeating one returns 422 DUPLICATE_PHOTO_INDEX. ' +
      'The index is also how the photo is read back later, at ' +
      'GET /api/v2/media/attempts/{attemptId}/photo/{index}.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_PHOTOS_PER_ATTEMPT - 1)
  index!: number;

  /** Declared upfront so the presigned PUT can pin the exact length. */
  @ApiProperty({
    example: 184320,
    minimum: 1,
    maximum: MAX_PHOTO_BYTES,
    description:
      'Exact byte length of the JPEG you are about to upload. It is signed into the presigned ' +
      'PUT as Content-Length, so S3 rejects an upload of any other length, and finalize only ' +
      'accepts an object whose real size matches this number to the byte. Finalize also treats ' +
      'anything under 1024 bytes as a failed upload rather than evidence, so the practical floor ' +
      `is 1024 even though the field accepts 1. Ceiling is ${MAX_PHOTO_BYTES} (10 MB).`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_PHOTO_BYTES)
  sizeBytes!: number;
}

export class DeclaredSignatureDto {
  @ApiProperty({
    example: 24576,
    minimum: 1,
    maximum: MAX_SIGNATURE_BYTES,
    description:
      'Exact byte length of the signature PNG. Signed into the presigned PUT the same way a ' +
      'photo size is, so it cannot be revised after the fact. Finalize accepts the signature ' +
      `once the stored object is at least 1024 bytes. Ceiling is ${MAX_SIGNATURE_BYTES} (2 MB).`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_SIGNATURE_BYTES)
  sizeBytes!: number;
}

/**
 * Structural validation lives here; the cross-field evidence matrix
 * (which outcome requires which evidence) is enforced in the service via
 * domain/outcomes.ts so DTO and DB share one source of truth.
 *
 * The per-field `example` values below describe each field on its own. They do
 * NOT combine into a legal body, because the evidence matrix makes several of
 * them mutually exclusive: an attempt carrying both a reasonCode and a
 * signature cannot satisfy any outcome. The runnable bodies are the named
 * examples on @ApiBody in attempts.controller.ts, one per outcome.
 */
export class CreateAttemptDto {
  @ApiProperty({
    example: '3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d',
    format: 'uuid',
    description:
      'UUID v4 minted on the handset before the request is sent, and the idempotency key for ' +
      'this attempt. Re-sending the same id with the same body returns 200 with ' +
      'deduplicated: true and creates nothing; re-sending it with a DIFFERENT body returns 422 ' +
      'IDEMPOTENCY_PAYLOAD_MISMATCH, because a reused key is a client bug and guessing which ' +
      'version is real would corrupt evidence. In this page that means: change this value ' +
      'whenever you change anything else in the body.',
  })
  @IsUUID(4)
  clientAttemptId!: string;

  @ApiProperty({
    example: '28e634ba-ef89-4fcd-b21a-e9881367f757',
    format: 'uuid',
    description:
      'The stop being attempted. The example is a real pending stop on the seeded London round, ' +
      'so it runs as written. Any id from GET /api/v2/stops works too, which is where to go if ' +
      'the demo database is ever fully reseeded and this one stops resolving. The stop must be ' +
      'assigned to the driver whose token you are using, otherwise the attempt is either ' +
      'refused (403) or accepted and flagged as a conflict, depending on whether the capture ' +
      'predates the reassignment.',
  })
  @IsUUID(4)
  stopId!: string;

  @ApiProperty({
    enum: ALL_OUTCOMES,
    example: Outcome.DeliveredToPerson,
    description:
      'What happened at the door. Each outcome carries its own evidence rule, checked in the ' +
      'service against domain/outcomes.ts and rejected with 422 EVIDENCE_RULES_VIOLATED when ' +
      'the body does not match: ' +
      'delivered_to_person needs a signature, and no reason and no neighbour house number. ' +
      'left_with_neighbour needs at least 1 photo and neighbourHouseNumber, and no signature. ' +
      'left_safe_place needs at least 1 photo (the photo is the proof), and nothing else. ' +
      'no_answer_carded needs at least 1 photo of the card, and nothing else. ' +
      'refused needs a reasonCode, and no signature. ' +
      'access_failure needs a reasonCode, and no signature. ' +
      `Every outcome allows up to ${MAX_PHOTOS_PER_ATTEMPT} photos.`,
  })
  @IsIn(ALL_OUTCOMES)
  outcome!: Outcome;

  @ApiPropertyOptional({
    example: 'JD0114937265',
    maxLength: 64,
    description:
      'The barcode on the parcel, as the driver captured it. Optional because a driver can be ' +
      'standing at a door with an unreadable label. If you send it you must also send ' +
      'barcodeSource, which is only validated when this field is present.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parcelBarcode?: string;

  @ApiPropertyOptional({
    enum: ['scanned', 'manual'],
    example: 'manual',
    description:
      'How the barcode got into the payload. Required whenever parcelBarcode is present and ' +
      'meaningless without it. "scanned" means the camera read it, "manual" means a human typed ' +
      'it, and the two are not equally trustworthy when a delivery is later disputed.',
  })
  @ValidateIf((o: CreateAttemptDto) => o.parcelBarcode !== undefined)
  @IsIn(['scanned', 'manual'])
  barcodeSource?: 'scanned' | 'manual';

  /**
   * Whether the barcode matched what dispatch expected. Omitted when there was
   * nothing to compare against, which is a different claim from false.
   */
  @ApiPropertyOptional({
    example: true,
    description:
      'The client\'s answer to "did this barcode match what dispatch expected for this stop?". ' +
      'The server stores the claim and does not recompute it. Omit it when there was nothing to ' +
      'compare against, which is a different statement from false. The runnable examples on this ' +
      'endpoint leave it out for exactly that reason: a barcode pasted into Swagger has not been ' +
      'compared to the stop you picked, so claiming true would put a fabricated match in the ' +
      'evidence record.',
  })
  @IsOptional()
  @IsBoolean()
  barcodeMatch?: boolean;

  /**
   * Required by the app's own UI when the driver proceeds past a mismatch, and
   * accepted here whenever it is sent. The server does not refuse an attempt
   * for lacking it: refusing would push the driver into recording a different
   * outcome to get the evidence saved, which is worse data than an
   * unexplained override.
   */
  @ApiPropertyOptional({
    example: 'Label torn, matched the last four digits by hand',
    maxLength: 120,
    description:
      'Why the driver went ahead after barcodeMatch came back false. The handset UI demands it ' +
      'at that point; the server accepts it whenever it is sent and never refuses an attempt for ' +
      'lacking it. Refusing would push a driver into logging a different outcome just to get the ' +
      'evidence saved, and an unexplained override is better data than a false outcome.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  barcodeOverrideReason?: string;

  /** Carded and no-access only: the driver is coming back to this stop today. */
  @ApiPropertyOptional({
    example: true,
    description:
      '"I am coming back to this stop today." Only meaningful for no_answer_carded and ' +
      'access_failure, the two outcomes where the code alone cannot say whether the stop is ' +
      'finished for the day. On any other outcome the server stores false regardless of what you ' +
      'send: it is not rejected, it is just not a question a delivered or refused stop can answer.',
  })
  @IsOptional()
  @IsBoolean()
  retryToday?: boolean;

  @ApiPropertyOptional({
    example: '42',
    maxLength: 16,
    description:
      'House number the parcel was left at. Required for left_with_neighbour and forbidden for ' +
      'all five other outcomes: sending it alongside, say, delivered_to_person returns 422 ' +
      'EVIDENCE_RULES_VIOLATED. It is a string because "42B" and "Flat 3" are real answers.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  neighbourHouseNumber?: string;

  @ApiPropertyOptional({
    example: 'customer_refused',
    maxLength: 64,
    description:
      'Why the delivery could not be completed. Required for refused and access_failure, ' +
      'forbidden for the other four. The server does not police the vocabulary, but the seeded ' +
      'data uses customer_refused for a refusal and gate_locked for a no-access, so those two ' +
      'read consistently against the demo database.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  reasonCode?: string;

  @ApiPropertyOptional({
    example: 'Left in the porch, out of sight from the street.',
    maxLength: 500,
    description:
      'Free text the driver typed. Allowed on every outcome. Sending a note is also what triggers ' +
      'the office-side AI summary for the attempt, so it is the field to fill if you want to see ' +
      'that path run.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * Omit both when the handset had no fix. Sending 0,0 to satisfy a required
   * field records a position in the Gulf of Guinea as though it were observed.
   */
  @ApiPropertyOptional({
    example: 51.5246,
    minimum: -90,
    maximum: 90,
    description:
      'Latitude at capture, WGS84. Omit lat and lng together when the handset had no fix. Do not ' +
      'send 0,0 to fill the gap: that records a position in the Gulf of Guinea as though someone ' +
      'observed it. The example is in EC1, inside the seeded London round.',
  })
  @IsOptional()
  @IsNumber()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({
    example: -0.0996,
    minimum: -180,
    maximum: 180,
    description:
      'Longitude at capture, WGS84. Omit together with lat when there was no GPS fix.',
  })
  @IsOptional()
  @IsNumber()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({
    example: 8,
    minimum: 0,
    maximum: 100_000,
    description:
      'Reported horizontal accuracy of the fix, in metres. A delivery logged at 8 m and one ' +
      'logged at 800 m are not equally useful when a delivery is disputed, so the number is kept ' +
      'rather than the coordinates being treated as exact.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  gpsAccuracyM?: number;

  /** Device clock at capture - may be days in the past for offline work. */
  @ApiProperty({
    example: '2026-08-14T09:14:22.000Z',
    format: 'date-time',
    description:
      'The device clock when the driver captured the attempt, ISO 8601. Often days in the past: ' +
      'a handset with no signal captures now and syncs later, and back-dating is the normal case ' +
      'rather than an error. A value more than five minutes ahead of server time is still stored, ' +
      'flagged clock_suspect, because throwing away evidence over a wrong device clock helps ' +
      'nobody. Any past instant works here.',
  })
  @IsISO8601()
  capturedAt!: string;

  @ApiProperty({
    example: '2.0.0',
    maxLength: 32,
    description:
      'Version of the app that captured this attempt. Recorded on the row so a later dispute can ' +
      'be traced to the build that produced it. Use 2.0.0 for the v2 surface.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  appVersion!: string;

  @ApiPropertyOptional({
    type: DeclaredPhotoDto,
    isArray: true,
    maxItems: MAX_PHOTOS_PER_ATTEMPT,
    example: [{ index: 0, sizeBytes: 184320 }],
    description:
      'The photos this attempt WILL have, declared before any bytes exist. Declaring them is what ' +
      'lets the server know what evidence it is owed: the response comes back with one presigned ' +
      'PUT per photo, the handset uploads straight to S3, and finalize verifies each object. ' +
      `Up to ${MAX_PHOTOS_PER_ATTEMPT}, with unique indexes. Omit the field entirely for an ` +
      'attempt with no photos.',
  })
  @IsOptional()
  @Type(() => DeclaredPhotoDto)
  @ValidateNested({ each: true })
  photos?: DeclaredPhotoDto[];

  @ApiPropertyOptional({
    type: DeclaredSignatureDto,
    example: { sizeBytes: 24576 },
    description:
      'The signature PNG this attempt WILL have, declared the same way photos are. Present means ' +
      '"a signature was taken", which is required for delivered_to_person and forbidden for the ' +
      'other five outcomes. The server picks the S3 key itself, so there is nothing to name here.',
  })
  @IsOptional()
  @Type(() => DeclaredSignatureDto)
  @ValidateNested()
  signature?: DeclaredSignatureDto;
}
