import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The exact v1 POST body: { delivered, photo_url, signature_url, location, note }.
 * snake_case field names are part of the frozen contract.
 */
export class LegacyPodDto {
  @ApiProperty({
    description:
      'Whether the parcel was handed over. v1 has this one boolean where v2 has six outcomes, so false is recorded as no_answer_carded and true is mapped to the richest outcome the supplied evidence actually supports.',
    example: true,
  })
  @IsBoolean()
  delivered!: boolean;

  @ApiProperty({
    description:
      'Optional. URL of the doorstep photograph on the v1 media host. v1 stores its own media, so this API only records the link and never fetches or re-hosts it. Supplying this with delivered=true records the attempt as left_safe_place.',
    example: 'https://legacy-cdn.example.com/pods/demo-photo.jpg',
    maxLength: 2048,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  photo_url?: string;

  @ApiProperty({
    description:
      'Optional. URL of the captured signature on the v1 media host. Supplying this with delivered=true records the attempt as delivered_to_person, since a signature is the one piece of evidence that proves a person took it.',
    example: 'https://legacy-cdn.example.com/pods/demo-signature.png',
    maxLength: 2048,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  signature_url?: string;

  @ApiProperty({
    description:
      'Optional. Where the handset was, as "lat,lng". If it is missing or unparseable the stop\'s own coordinates are used instead, so an attempt always lands on the map somewhere defensible.',
    example: '51.5074,-0.1278',
    maxLength: 64,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  location?: string;

  @ApiProperty({
    description:
      "Optional. The driver's free text note, kept verbatim. Two identical bodies for the same stop within five minutes are treated as one retry, so changing the note is what makes a resubmission a genuinely new event.",
    example: 'Handed to resident at front door',
    maxLength: 2000,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
