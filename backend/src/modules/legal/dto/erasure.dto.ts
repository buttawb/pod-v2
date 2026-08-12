import { IsBoolean, IsIn, IsUUID } from 'class-validator';
import { SubjectType } from '../legal.service';

export class ErasureDto {
  @IsIn([SubjectType.Driver, SubjectType.OfficeUser])
  subjectType!: SubjectType;

  @IsUUID(4)
  subjectId!: string;

  /**
   * Required, and required to be exactly true.
   *
   * An erasure cannot be undone, so it should not be reachable by a request
   * that was assembled by accident. Defaulting this, or accepting a truthy
   * value, would make a mistyped call indistinguishable from an intended one.
   */
  @IsBoolean()
  confirm!: boolean;
}
