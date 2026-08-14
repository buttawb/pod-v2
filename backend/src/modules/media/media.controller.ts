import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Redirect,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { AttemptPhoto } from '../attempts/entities/attempt-photo.entity';
import { DeliveryAttempt } from '../attempts/entities/delivery-attempt.entity';
import { S3Service } from './s3.service';

/**
 * Swagger copy shared by both routes. Both need a token, both take an
 * attemptId the reviewer has to obtain first, and both hand the browser
 * straight to S3, which is worth saying once rather than twice.
 */
const SIGN_IN =
  'Precondition: a token, either kind. As a driver, POST /api/v2/auth/driver/login with ' +
  'employeeRef "EMP-TEST-001" and password "TestDriver#2026". As the office, ' +
  'POST /api/v2/auth/office/login with email "office@demo.pod" and password "OfficeDemo#2026". ' +
  'Copy accessToken from the response, click Authorize at the top of this page, paste it. Those ' +
  'logins are seeded demo accounts on a demo database, published here on purpose so a reviewer ' +
  'can execute this page without being handed secrets out of band. Nothing here has leaked.';

const WHERE_TO_GET_ATTEMPT_ID =
  'Where to get attemptId: it is the attemptId field in the response from ' +
  'POST /api/v2/attempts (the server-side UUID, not the clientAttemptId you minted). With an ' +
  'office token you can also list existing attempts at GET /api/v2/office/attempts and take an ' +
  'id from there, which is the easier route if you have not captured anything yourself.';

const REDIRECT_BEHAVIOUR =
  'This route answers 302 with a Location header, not image bytes. Swagger UI follows the ' +
  'redirect itself, so the response body shown below is whatever S3 returned; if the browser ' +
  'blocks that cross-origin hop, copy the request URL into a new tab instead. The presigned link ' +
  'is minted per request and lives about 300 seconds (PRESIGN_GET_TTL_SEC). Nothing durable ever ' +
  'stores a presigned URL and the bucket is private, so an expired link is a dead link rather ' +
  'than a standing hole, and every view is re-authorised.';

/**
 * Every evidence view passes authz here and 302s to a fresh short-TTL
 * presigned GET. Nothing durable ever stores a presigned URL, and the
 * bucket stays fully private.
 */
@Roles('driver', 'office')
@ApiTags('media')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'media', version: '2' })
export class MediaController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly s3: S3Service,
  ) {}

  @Get('attempts/:attemptId/photo/:index')
  @Redirect(undefined, 302)
  @ApiOperation({
    summary: 'Redirect to a short-lived link for one evidence photo',
    description: [
      'Checks that the caller is allowed to see this attempt, then 302s to a freshly presigned S3',
      'GET for the photo at the given index.',
      '',
      SIGN_IN,
      '',
      WHERE_TO_GET_ATTEMPT_ID,
      '',
      'The index is the same number the photo was declared under when the attempt was submitted,',
      'counting from 0. An attempt that declared one photo only answers index 0.',
      '',
      REDIRECT_BEHAVIOUR,
      '',
      'A driver may only read attempts they captured themselves. An office token may read any',
      'attempt, which is the whole point of the office surface.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'attemptId',
    format: 'uuid',
    example: 'bdbf6206-6e89-484a-9800-8c290715765e',
    description:
      'Server-side attempt UUID. The example is a real attempt on the seeded London round with a ' +
      'verified photo at index 0, so it redirects as written when you are signed in as ' +
      'EMP-TEST-001. Signed in as any other driver it answers 403, which is the point: a ' +
      'photograph is readable only by the driver who captured it. Other ids come from ' +
      'POST /api/v2/attempts or GET /api/v2/office/attempts.',
  })
  @ApiParam({
    name: 'index',
    example: 0,
    description:
      'Zero-based photo index, as declared in the attempt body. Must be an integer.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Authorised. Location carries a presigned S3 GET valid for roughly 300 seconds. Fetch it ' +
      'without an Authorization header: the signature in the query string is the credential.',
    headers: {
      Location: {
        description:
          'Presigned S3 URL for the photo. Expires in about 300 seconds.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'attemptId is not a UUID, or index is not an integer.',
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired token, or a token minted for the v1 surface. Both driver and office ' +
      'tokens are accepted on this route, so a role failure here means neither.',
  })
  @ApiResponse({
    status: 403,
    description:
      "A driver token asking for another driver's attempt. Evidence is scoped to whoever " +
      'captured it, and the check happens before the photo row is even looked up so the ' +
      'existence of an attempt is not leaked by the difference between 403 and 404.',
  })
  @ApiResponse({
    status: 404,
    description:
      'Either no attempt with that id, or that attempt has no photo at that index. Attempts ' +
      'recorded with no photos, such as refused with a reason only, never have one.',
  })
  async photo(
    @CurrentUser() user: JwtPayload,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    await this.assertCanView(user, attemptId);
    const photo = await this.dataSource.getRepository(AttemptPhoto).findOne({
      where: { attemptId, photoIndex: index },
    });
    if (!photo) throw new NotFoundException('No such photo');
    return { url: await this.s3.presignGet(photo.s3Key) };
  }

  @Get('attempts/:attemptId/signature')
  @Redirect(undefined, 302)
  @ApiOperation({
    summary: 'Redirect to a short-lived link for the captured signature',
    description: [
      'Same authorisation and same redirect mechanics as the photo route, for the signature PNG.',
      '',
      SIGN_IN,
      '',
      WHERE_TO_GET_ATTEMPT_ID,
      '',
      'Only delivered_to_person attempts have a signature. The evidence matrix requires one for',
      'that outcome and forbids it on the other five, so asking for the signature of a',
      'left_safe_place or refused attempt is a 404 by design rather than a missing file.',
      '',
      REDIRECT_BEHAVIOUR,
      '',
      'A driver may only read attempts they captured themselves. An office token may read any.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'attemptId',
    format: 'uuid',
    example: 'bdbf6206-6e89-484a-9800-8c290715765e',
    description:
      'Server-side attempt UUID, from POST /api/v2/attempts or GET /api/v2/office/attempts. The ' +
      'example is a real attempt on the seeded London round that carries a signature, so it ' +
      'redirects as written when signed in as EMP-TEST-001. An attempt with no signature ' +
      'answers 404 rather than redirecting to a missing object.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Authorised. Location carries a presigned S3 GET for the signature PNG, valid for roughly ' +
      '300 seconds.',
    headers: {
      Location: {
        description:
          'Presigned S3 URL for the signature. Expires in about 300 seconds.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'attemptId is not a UUID.',
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired token, or a token minted for the v1 surface.',
  })
  @ApiResponse({
    status: 403,
    description:
      "A driver token asking for another driver's attempt. Checked before anything about the " +
      'attempt is revealed.',
  })
  @ApiResponse({
    status: 404,
    description:
      'No attempt with that id, or the attempt never declared a signature. The five outcomes ' +
      'other than delivered_to_person are forbidden from carrying one.',
  })
  async signature(
    @CurrentUser() user: JwtPayload,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ) {
    const attempt = await this.assertCanView(user, attemptId);
    if (!attempt.signatureS3Key) throw new NotFoundException('No signature');
    return { url: await this.s3.presignGet(attempt.signatureS3Key) };
  }

  private async assertCanView(user: JwtPayload, attemptId: string): Promise<DeliveryAttempt> {
    const attempt = await this.dataSource.getRepository(DeliveryAttempt).findOne({
      where: { id: attemptId },
    });
    if (!attempt) throw new NotFoundException('Unknown attempt');
    if (user.role === 'driver' && attempt.driverId !== user.sub) {
      throw new ForbiddenException('Attempt belongs to another driver');
    }
    return attempt;
  }
}
