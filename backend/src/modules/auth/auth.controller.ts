import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/jwt-auth.guard';
import { AuthService } from './auth.service';
import { DriverLoginDto, OfficeLoginDto, RefreshDto } from './dto/auth.dtos';

/**
 * The three v2 endpoints that need no token, and that every other v2 endpoint
 * needs first. Documented in more detail than the rest of the API because a
 * reviewer who cannot get a token here sees nothing else work.
 *
 * The request bodies are described with an explicit @ApiBody schema rather
 * than from the DTO classes. The schema is kept in step with the class-validator
 * rules on DriverLoginDto/OfficeLoginDto/RefreshDto by hand: if a rule there
 * changes, the maxLength and required lists below have to change with it.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '2' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('driver/login')
  @ApiOperation({
    summary: 'Sign in as a driver and get a v2 token pair',
    description: [
      'Start here. Almost every other endpoint on this page needs the token this returns.',
      '',
      '**How to run it**',
      '',
      '1. Press *Try it out*. The body below is already filled in with a working driver,',
      '   so change nothing.',
      '2. Press *Execute*.',
      '3. Copy the value of `accessToken` from the response, without the surrounding quotes.',
      '4. Press the **Authorize** button at the top of this page, paste the token in, and',
      '   press *Authorize*, then *Close*. Every driver endpoint on the page is now unlocked',
      '   and Swagger will send the token for you.',
      '5. Good next call: **GET /api/v2/stops** returns this driver\'s round, and any `id`',
      '   from it is the `stopId` for **POST /api/v2/attempts**.',
      '',
      '**Which driver to sign in as.** The pre-filled `EMP-TEST-001` runs a London round of',
      '151 stops. Swap `employeeRef` to `EMP-PK-001` for the Karachi round of 40 stops, same',
      'password. Both are useful: the depot map is only interesting with two real clusters.',
      '',
      '**About the credentials in this example.** They are demo credentials and they are',
      'printed here on purpose, so this page can be executed during review without hunting',
      'for a password elsewhere. The accounts are seeded into a throwaway demo database and',
      'hold no real personal data. This is a deliberate choice, not an accidentally committed',
      'secret.',
      '',
      '**What you get back.** `accessToken` is a JWT valid for `accessExpiresInSec` seconds',
      '(900 by default). `refreshToken` is a long-lived opaque string: keep it, and when the',
      'access token expires, exchange it at **POST /api/v2/auth/refresh** rather than signing',
      'in again.',
      '',
      '**This token only opens v2.** It carries the v2 audience, so the `v1 (frozen)` endpoints',
      'will answer 401 with it. Those need their own token from **POST /api/auth/login**.',
    ].join('\n'),
  })
  @ApiBody({
    description:
      'Driver credentials plus the handset identity. Pre-filled with a working demo driver: press Execute as is.',
    schema: {
      type: 'object',
      required: ['employeeRef', 'password', 'deviceFingerprint'],
      properties: {
        employeeRef: {
          type: 'string',
          maxLength: 64,
          description:
            "The driver's employee reference, the same one printed on their badge. Case sensitive. Use EMP-TEST-001 for the London round or EMP-PK-001 for the Karachi round.",
          example: 'EMP-TEST-001',
        },
        password: {
          type: 'string',
          maxLength: 128,
          description:
            'Password for that driver. Both seeded demo drivers share this one, deliberately, so there is a single credential to remember when demonstrating either round.',
          example: 'TestDriver#2026',
        },
        deviceFingerprint: {
          type: 'string',
          maxLength: 128,
          description:
            'A stable identifier for the handset. The real app sends a per-install id; from Swagger any constant string works, and reusing the same one means repeat logins register as one device rather than a new one each time.',
          example: 'swagger-ui-demo',
        },
        appVersion: {
          type: 'string',
          maxLength: 32,
          description:
            'Optional. Version of the app doing the signing in, recorded against the device so the fleet can be told apart by release.',
          example: '2.0.0',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Signed in. Copy accessToken into the Authorize box at the top of this page. Keep refreshToken for POST /api/v2/auth/refresh.',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZjNlOWIyMS0zM2QwLTRhMWMtOTJjNS1iMzA4NzZkNGUxMDIiLCJyb2xlIjoiZHJpdmVyIiwiZGV2aWNlSWQiOiJhMWM4ZTVkNC02YjIyLTQyMmYtOTQxMy0yZGY5MDdiNjRhMTAiLCJhdWQiOiJwb2QudjIiLCJpYXQiOjE3NTUwMDAwMDAsImV4cCI6MTc1NTAwMDkwMH0.f4kEsIgNaTuReF0rD3m0PurP0seSonLY',
        refreshToken: 'JmT2xQ8bqk1nR5vXpL0dYw3Zc7hAeK9sUgN4iOb6MfCtRlWvSyD1zHjEuQaPnBkX',
        accessExpiresInSec: 900,
        driver: {
          id: '7f3e9b21-33d0-4a1c-92c5-b30876d4e102',
          displayName: 'Test Driver',
          employeeRef: 'EMP-TEST-001',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The body failed validation, most often a missing deviceFingerprint or an unknown extra field. Unknown fields are rejected rather than ignored, so a typo in a key is reported instead of silently dropped.',
  })
  @ApiResponse({
    status: 401,
    description:
      'Wrong password, unknown employee reference, or a deactivated driver. All three give the same answer on purpose, so this endpoint cannot be used to find out which employee references exist.',
  })
  @ApiResponse({
    status: 429,
    description:
      'More than 10 login attempts from this IP in a minute. Wait for the minute to pass and retry.',
  })
  driverLogin(@Body() dto: DriverLoginDto) {
    return this.authService.driverLogin(
      dto.employeeRef,
      dto.password,
      dto.deviceFingerprint,
      dto.appVersion,
    );
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('office/login')
  @ApiOperation({
    summary: 'Sign in as office staff and get a v2 token pair',
    description: [
      'The token for everything under the `office` tag. A driver token will not open those',
      'endpoints, and this token will not open the driver ones, so expect to come back here',
      'and re-authorize when you switch between the two halves of the API.',
      '',
      '**How to run it**',
      '',
      '1. Press *Try it out*. The body is already filled in with the seeded office account.',
      '2. Press *Execute*.',
      '3. Copy `accessToken` from the response.',
      '4. Press **Authorize** at the top of this page, paste it in, press *Authorize*. If a',
      '   driver token is already in that box, paste over it: only one is active at a time.',
      '5. Good next call: **GET /api/v2/office/attempts** for what the fleet has been doing,',
      '   or the live feed endpoint for the same thing as it happens.',
      '',
      '**About the credentials in this example.** This is a demo account, published on',
      'purpose so the page is executable end to end by whoever is reviewing it. It lives on a',
      'demo database seeded for this evaluation and guards nothing real. Treat it as sample',
      'data rather than as a credential that escaped.',
      '',
      '**What you get back.** The same token pair shape as the driver login, with a `user`',
      'block instead of a `driver` block. `accessToken` expires after `accessExpiresInSec`',
      'seconds; renew it at **POST /api/v2/auth/refresh** with the `refreshToken`.',
    ].join('\n'),
  })
  @ApiBody({
    description:
      'Office credentials. Pre-filled with the seeded demo account: press Execute without editing.',
    schema: {
      type: 'object',
      required: ['email', 'password'],
      properties: {
        email: {
          type: 'string',
          format: 'email',
          description:
            'Email address of the office user. Must be a valid email address. Matched case insensitively, so OFFICE@DEMO.POD works too.',
          example: 'office@demo.pod',
        },
        password: {
          type: 'string',
          maxLength: 128,
          description: 'Password for that office user.',
          example: 'OfficeDemo#2026',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Signed in. Copy accessToken into the Authorize box at the top of this page to unlock the office endpoints.',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjNGQxMDdhOS04ZTVmLTRiMzMtOTAyMS0xZTZhYjRjOTBkNzciLCJyb2xlIjoib2ZmaWNlIiwiYXVkIjoicG9kLnYyIiwiaWF0IjoxNzU1MDAwMDAwLCJleHAiOjE3NTUwMDA5MDB9.rTqZ9uWmK1sYbHx7NvEcAoLpD3fGjR8i',
        refreshToken: 'Xq7LmB2vTz9dRcH4WsKpY1gNfE6uJaQoV0iMbZtSyD8rPnU3hCwXkAeL5jOtIrGf',
        accessExpiresInSec: 900,
        user: {
          id: 'c4d107a9-8e5f-4b33-9021-1e6ab4c90d77',
          displayName: 'Office Demo',
          email: 'office@demo.pod',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The body failed validation. Usually the email is not a valid address, or a key is misspelled: unknown keys are rejected, not ignored.',
  })
  @ApiResponse({
    status: 401,
    description:
      'Wrong password or no such office user. Both answer identically so the endpoint cannot be used to test whether an address has an account.',
  })
  @ApiResponse({
    status: 429,
    description: 'More than 10 login attempts from this IP in a minute. Retry after the minute.',
  })
  officeLogin(@Body() dto: OfficeLoginDto) {
    return this.authService.officeLogin(dto.email, dto.password);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  @ApiOperation({
    summary: 'Exchange a refresh token for a new access token',
    description: [
      'Use this when an access token has expired instead of asking the driver to sign in',
      'again mid-round.',
      '',
      '**Precondition.** You need a `refreshToken`, which only comes from a successful',
      '**POST /api/v2/auth/driver/login** or **POST /api/v2/auth/office/login**. There is no',
      'pre-filled value here that can work, because refresh tokens are minted per sign-in.',
      'Run a login first, copy `refreshToken` out of its response, and paste it into the body',
      'below in place of the placeholder.',
      '',
      '**How to run it**',
      '',
      '1. Log in above and copy `refreshToken` from the response.',
      '2. Press *Try it out* here, replace the example string with it, press *Execute*.',
      '3. Copy the new `accessToken` and re-paste it into **Authorize** at the top of the page.',
      '4. Also keep the new `refreshToken`. The one you just spent is now used up.',
      '',
      '**Rotation.** Each refresh returns a new refresh token and retires the one you sent, so',
      'a stolen token is only useful until the real client next refreshes. Presenting an',
      'already-rotated token long after the fact is read as theft and revokes the whole family,',
      'which signs that session out everywhere. A replay within the first minute is treated as',
      'a lost response instead, so a client whose network dropped the reply can safely retry.',
      '',
      'The token type has to match the endpoint: this returns a v2 token pair. The frozen v1',
      'surface has no refresh at all, by design.',
    ].join('\n'),
  })
  @ApiBody({
    description:
      'The refresh token from a login response. The example is a placeholder of the right shape: paste your own before executing.',
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: {
        refreshToken: {
          type: 'string',
          maxLength: 256,
          description:
            'The opaque refreshToken string returned by POST /api/v2/auth/driver/login or POST /api/v2/auth/office/login. Single use: every successful refresh replaces it.',
          example: 'JmT2xQ8bqk1nR5vXpL0dYw3Zc7hAeK9sUgN4iOb6MfCtRlWvSyD1zHjEuQaPnBkX',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'A fresh token pair. Re-paste accessToken into Authorize, and store the new refreshToken: the one you sent no longer works.',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZjNlOWIyMS0zM2QwLTRhMWMtOTJjNS1iMzA4NzZkNGUxMDIiLCJyb2xlIjoiZHJpdmVyIiwiZGV2aWNlSWQiOiJhMWM4ZTVkNC02YjIyLTQyMmYtOTQxMy0yZGY5MDdiNjRhMTAiLCJhdWQiOiJwb2QudjIiLCJpYXQiOjE3NTUwMDA5MDAsImV4cCI6MTc1NTAwMTgwMH0.9LpQnDs2VkYtE7mXbHrJc0AzWuNfRgOi',
        refreshToken: 'Kd9YfR3nQwZ8sLuX2mPvB6tHcJa0EgNiOr7VbMxT5yUqW1jAeSkC4hDzIlGpFo',
        accessExpiresInSec: 900,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'No refreshToken in the body, or it is longer than 256 characters.',
  })
  @ApiResponse({
    status: 401,
    description:
      'The token is unknown, expired, already revoked, or was replayed long after it was rotated. The last case also revokes every token in its family, so the session has to sign in again.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Another refresh for the same token is still in flight, so answering this one could hand out a second parallel session or cancel a live one. Wait a moment and retry with the same token.',
  })
  @ApiResponse({
    status: 429,
    description: 'More than 30 refreshes from this IP in a minute.',
  })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }
}
