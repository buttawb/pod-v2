import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({
    summary: 'DESTRUCTIVE: erase a subject under UK GDPR Article 17. Irreversible.',
    description: [
      '**This one cannot be undone.** It redacts a real person out of the database and there is',
      'no restore path, no soft delete and no undo route. Read the whole description before you',
      'press Execute.',
      '',
      '**Do not run this against the demo drivers.** EMP-TEST-001 and EMP-PK-001 are the seeded',
      'accounts the rest of this page depends on. Erasing one overwrites its password with a',
      'random unusable hash, so the driver login stops working and every driver endpoint on this',
      'page becomes unrunnable for everyone after you. The same goes for the office account you',
      'are signed in as. The body below is pre-filled with a UUID that belongs to nobody, so',
      'executing it as it stands returns 404 and changes nothing.',
      '',
      '`confirm` must be present and exactly `true`. A missing or false value is answered with',
      '400 rather than treated as a no-op, so an accidentally assembled request cannot erase',
      'anyone.',
      '',
      '**What it does.** In one transaction: clears the subject contact fields (`email` to null',
      'for a driver, to a non-routing `.invalid` address for an office user, since that column',
      'is unique and not nullable; `display_name` to `[erased]` on both, because the column is',
      'not nullable and a marker states plainly what happened where a null would just look like',
      'missing data). It then overwrites `password_hash` with a bcrypt hash of 32 random bytes,',
      'which is what actually ends access: revoking sessions alone would let the subject sign in',
      'again seconds later. It revokes every refresh token they hold, and writes an audit row',
      'recording who did it, to whom, and which field names were cleared. Field names only,',
      'never values: a log quoting the old address would reinstate what the erasure removed.',
      '',
      '**What it deliberately does not touch.** `delivery_attempts` and `attempt_photos` are',
      'never modified or deleted. Proof of delivery is evidence kept for the establishment,',
      'exercise or defence of legal claims, which UK GDPR Article 17(3)(e) exempts from the',
      'right to erasure while that purpose lasts. Here that is six years, and the photographs',
      'are destroyed by an S3 lifecycle rule at the end of it rather than by anything in this',
      'code path. The exclusion is structural, not a filter someone could widen: the database',
      'role holds no DELETE on either table. `employee_ref` also survives, because it is what',
      'ties retained evidence to the person who captured it. The response reports',
      '`evidenceRetained` so the count of what was kept is part of the answer to the request.',
      '',
      'Requires an OFFICE token, and is not reachable with a driver one at all: an erasure',
      'request is handled by an operator who has established who is asking, and putting it',
      'behind a driver session on a shared handset would make it reachable by whoever is holding',
      'the phone. Get a token from POST /api/v2/auth/office/login with office@demo.pod /',
      'OfficeDemo#2026, then press Authorize at the top of this page. Those credentials are',
      'stated openly on purpose: the account is seeded for this evaluation on a demo database,',
      'so it is a published demo login rather than a leaked one.',
      '',
      'The actor recorded in the audit log is taken from your token, not from the body, so it',
      'cannot be attributed to someone else by the caller.',
      '',
      'Returns 201 rather than 200. That is the Nest default for POST and the route does not',
      'override it.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 201,
    description:
      'The subject was erased. `fieldsRedacted` lists what was cleared, including the ' +
      'credential. `evidenceRetained` counts the delivery attempts kept under the ' +
      'Article 17(3)(e) exemption, which is always 0 for an office user: they file no evidence.',
    schema: {
      example: {
        subjectType: 'driver',
        subjectId: 'b7c2f0d4-5c3a-4f88-9f4a-1f6d2e0a44c9',
        fieldsRedacted: ['email', 'display_name', 'password_hash'],
        tokensRevoked: 2,
        evidenceRetained: 151,
        erasedAt: '2026-08-14T10:22:07.441Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      '`confirm` was missing or false, `subjectType` was not `driver` or `office_user`, or ' +
      '`subjectId` was not a UUID v4. Nothing was erased.',
    schema: {
      example: {
        message: 'Erasure is irreversible and must be confirmed explicitly: send confirm: true',
        error: 'Bad Request',
        statusCode: 400,
      },
    },
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired token, or a driver token. The guard answers 401 for the wrong role ' +
      'as well, so "Insufficient role" here means you are signed in as a driver.',
    schema: {
      example: { message: 'Insufficient role', error: 'Unauthorized', statusCode: 401 },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'No subject of that type with that id, so the transaction rolled back and nothing was ' +
      'touched. This is what the pre-filled example body returns, which is why it is safe to ' +
      'press.',
    schema: {
      example: { message: 'Unknown driver', error: 'Not Found', statusCode: 404 },
    },
  })
  erase(@CurrentUser() user: JwtPayload, @Body() dto: ErasureDto) {
    return this.legal.erase(user.sub, dto.subjectType, dto.subjectId, dto.confirm);
  }
}
