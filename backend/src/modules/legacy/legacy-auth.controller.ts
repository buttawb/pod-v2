import { Body, Controller, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/jwt-auth.guard';
import { LegacyLoginDto } from './dto/legacy-login.dto';
import { LegacyAuthService } from './legacy-auth.service';

/**
 * Sign-in for the frozen v1 surface.
 *
 * Deliberately its own controller, its own service and its own token
 * lifetime, sharing nothing with v2 but the driver identity store. The drivers
 * are the same people, so their credentials must not fork; the tokens they are
 * handed must, because v2's auth will keep changing and 30% of the fleet
 * cannot take an app update to keep up.
 *
 * The real v1.4.2 login contract is not in the brief, so this stands in for it:
 * enough for the compat surface to be exercised end to end and pinned by
 * tests. Documented as an assumption. If the real one differs, this is the one
 * file that changes, and no v2 code moves.
 */
@ApiTags('v1 (frozen)')
@Controller({ path: 'auth', version: VERSION_NEUTRAL })
export class LegacyAuthController {
  constructor(private readonly legacyAuth: LegacyAuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LegacyLoginDto) {
    return this.legacyAuth.login(dto.email, dto.password);
  }
}
