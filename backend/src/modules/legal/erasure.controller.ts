import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { ErasureDto } from './dto/erasure.dto';
import { LegalService } from './legal.service';

/**
 * Office-role only, and deliberately not reachable from a handset.
 *
 * A subject-access or erasure request arrives through the operator, who has
 * to establish who is asking before anything is cleared. Putting an
 * irreversible action behind a driver's session on a shared device would make
 * it reachable by whoever is holding the phone.
 */
@Roles('office')
@ApiTags('legal')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'legal', version: '2' })
export class ErasureController {
  constructor(private readonly legal: LegalService) {}

  @Post('erasure')
  erase(@CurrentUser() user: JwtPayload, @Body() dto: ErasureDto) {
    return this.legal.erase(user.sub, dto.subjectType, dto.subjectId, dto.confirm);
  }
}
