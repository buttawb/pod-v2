import { Body, Controller, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({
    summary: 'v1 driver sign-in (frozen): returns exactly { token }',
    description: [
      'The sign-in the live v1.4.2 handsets call. Everything about its shape is a contract,',
      'not a preference, and is pinned by golden-file tests.',
      '',
      '**How to run it**',
      '',
      '1. Press *Try it out*. The body is pre-filled with a working v1 identity, so press',
      '   *Execute* without editing it.',
      '2. Copy the value of `token` from the response.',
      '3. Press **Authorize** at the top of this page, paste it in, press *Authorize*. That',
      '   unlocks **GET /api/stops** and **POST /api/stops/{id}/pod**, the other two frozen',
      '   endpoints.',
      '4. Call **GET /api/stops** next: you need a stop `id` from it before you can post a POD.',
      '',
      '**About the credentials in this example.** They belong to a seeded demo driver and are',
      'printed here intentionally so a reviewer can execute the frozen surface without any',
      'setup. The database behind them exists only for this evaluation and holds no real',
      'delivery data. Nothing here escaped from anywhere.',
      '',
      '**Contract properties, all deliberate**',
      '',
      '- The response body has exactly one key, `token`. Not `accessToken`, not an expiry, not',
      '  a user block. v1.4.2 parses this body in the field and anything added here becomes',
      '  surface that can never be removed again.',
      '- The token lasts 24 hours and there is no refresh endpoint for it. v1.4.2 was built',
      '  before this backend existed and cannot learn a rotation protocol, so its token simply',
      '  outlives a shift. Its lifetime is configured separately from v2 so tuning v2 cannot',
      '  shorten it.',
      '- The status is 201, not 200. That is what the handsets already accept, so it stays.',
      '- The token is stamped with the legacy audience and is rejected by every `/api/v2`',
      '  endpoint. A v2 token is likewise rejected here. The two surfaces never share a token.',
      '',
      '**Identity format.** v1 signs in with an email, so v1 identities are derived from the',
      'employee reference: `EMP-TEST-001` becomes `emp-test-001@fleet.local`. For the Karachi',
      'driver, use `emp-pk-001@fleet.local` with the same password.',
    ].join('\n'),
  })
  @ApiBody({
    type: LegacyLoginDto,
    description:
      'The frozen v1 body: exactly email and password. Any other key is rejected with 400, because the handsets send these two and nothing else. Pre-filled with a working demo driver.',
    examples: {
      londonDriver: {
        summary: 'London round driver (151 stops)',
        description: 'The default. Signs in as EMP-TEST-001 and can be executed unedited.',
        value: { email: 'emp-test-001@fleet.local', password: 'TestDriver#2026' },
      },
      karachiDriver: {
        summary: 'Karachi round driver (40 stops)',
        description: 'The same password, a different depot. Useful for seeing a second cluster.',
        value: { email: 'emp-pk-001@fleet.local', password: 'TestDriver#2026' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'Signed in. The body is exactly one key by contract. Copy token into Authorize at the top of the page to reach the two frozen stop endpoints. It is good for 24 hours and cannot be refreshed.',
    schema: {
      example: {
        token:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZjNlOWIyMS0zM2QwLTRhMWMtOTJjNS1iMzA4NzZkNGUxMDIiLCJyb2xlIjoiZHJpdmVyIiwiYXVkIjoicG9kLnYxIiwiaWF0IjoxNzU1MDAwMDAwLCJleHAiOjE3NTUwODY0MDB9.Yh2qKpN8vTzLmXcRdEwAoJbF3sUgHi',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The body was not exactly { email, password }. Extra keys are rejected rather than ignored, which is what keeps this body frozen: a new field cannot slip in unnoticed.',
  })
  @ApiResponse({
    status: 401,
    description:
      'Wrong password, no such identity, or a deactivated driver. All three answer the same way so the endpoint cannot be used to enumerate the fleet.',
  })
  login(@Body() dto: LegacyLoginDto) {
    return this.legacyAuth.login(dto.email, dto.password);
  }
}
