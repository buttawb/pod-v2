import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class EditSummaryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  finalText!: string;
}
