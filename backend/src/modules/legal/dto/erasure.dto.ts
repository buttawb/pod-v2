import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsUUID } from 'class-validator';
import { SubjectType } from '../legal.service';

export class ErasureDto {
  @ApiProperty({
    description:
      'Which table the subject lives in. `driver` redacts a driver, `office_user` redacts an ' +
      'office account. Anything else is rejected: there is no wildcard and no "all".',
    enum: [SubjectType.Driver, SubjectType.OfficeUser],
    example: SubjectType.Driver,
  })
  @IsIn([SubjectType.Driver, SubjectType.OfficeUser])
  subjectType!: SubjectType;

  @ApiProperty({
    description:
      'The id of the person to erase (UUID v4). This is irreversible, so read the operation ' +
      'description before changing it. The value pre-filled here is a well-formed UUID that ' +
      'belongs to nobody, so executing the box unedited answers 404 and erases nothing. That is ' +
      'deliberate: the pre-filled body on a destructive route should be safe to press. Do NOT ' +
      'substitute the id of the seeded demo drivers EMP-TEST-001 or EMP-PK-001, because erasing ' +
      'one invalidates its password and the rest of this page stops working.',
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000000',
  })
  @IsUUID(4)
  subjectId!: string;

  /**
   * Required, and required to be exactly true.
   *
   * An erasure cannot be undone, so it should not be reachable by a request
   * that was assembled by accident. Defaulting this, or accepting a truthy
   * value, would make a mistyped call indistinguishable from an intended one.
   */
  @ApiProperty({
    description:
      'Must be exactly true, and must be sent. It is not optional and it has no default: an ' +
      'erasure cannot be undone, so a request assembled by accident should not be able to ' +
      'reach one. `false` is answered with 400, not with a silent no-op. A truthy value such ' +
      'as "true" or 1 is not accepted either.',
    example: true,
  })
  @IsBoolean()
  confirm!: boolean;
}
