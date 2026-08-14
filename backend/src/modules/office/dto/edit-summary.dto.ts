import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class EditSummaryDto {
  @ApiProperty({
    description:
      'The exact sentence the customer will read. Replaces `finalText` only: the AI draft is ' +
      'never overwritten, so the record keeps both what the model wrote and what a person ' +
      'decided to send. Must not be empty and must be 200 characters or fewer. Keep it to what ' +
      'the outcome supports, and do not name the hiding place for a parcel left unattended: the ' +
      'exact spot is told to the recipient in the authenticated app, not in text that can be ' +
      'read off a lock screen.',
    example: 'Delivered and left in your chosen safe place. A photo is on file.',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  finalText!: string;
}
