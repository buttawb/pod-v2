import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { AttemptsService } from './attempts.service';
import { CreateAttemptDto } from './dto/create-attempt.dto';

/**
 * Swagger copy shared by the three routes below.
 *
 * All of them are driver-only and all of them are useless without a token, so
 * the sign-in recipe is written once and pasted into each description rather
 * than half-said three times.
 */
const SIGN_IN =
  'Precondition: you need a driver token. Call POST /api/v2/auth/driver/login with ' +
  'employeeRef "EMP-TEST-001" and password "TestDriver#2026" (the London round, 151 stops), ' +
  'copy accessToken out of the response, then click Authorize at the top of this page and ' +
  'paste it. Those credentials are seeded demo accounts on a demo database and are printed ' +
  'here deliberately so this page can be executed during review. They are not a leaked secret. ' +
  'An office token is rejected here with 401 Insufficient role, not 403: these routes are ' +
  'driver-only.';

/**
 * A real pending stop on the seeded London round, so every example body below
 * executes as written rather than 404ing on a made-up id.
 *
 * It survives the nightly demo roll, which shifts created_at forward and leaves
 * ids alone, so this stays valid for the life of the demo database. A full
 * reseed would regenerate it, which is why the description tells the reader
 * where to get another one rather than presenting this as permanent.
 */
const EXAMPLE_STOP_ID = '28e634ba-ef89-4fcd-b21a-e9881367f757';

const REPLACE_STOP_ID =
  `stopId ${EXAMPLE_STOP_ID} is a real pending stop on the seeded London round, so this body ` +
  'runs as written. Any other id from GET /api/v2/stops works too, and a stop belonging to ' +
  'another driver is either refused or accepted and flagged as a conflict.';

@Roles('driver')
@ApiTags('attempts')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'attempts', version: '2' })
export class AttemptsController {
  constructor(private readonly attemptsService: AttemptsService) {}

  @Post()
  @HttpCode(200) // replays return the same shape as first delivery - both are "success"
  @ApiOperation({
    summary: 'Record a delivery attempt (the one write path for evidence)',
    description: [
      'Submits what happened at a door. This is the only endpoint that writes evidence: there is',
      'no edit and no delete anywhere in the API, and a correction is a new attempt.',
      '',
      SIGN_IN,
      '',
      'How to run it: pick a body from the Examples dropdown just above the box (there is one per',
      'outcome, each already carrying the evidence that outcome requires), then replace stopId',
      'with a real one. GET /api/v2/stops returns your round for today; copy the id of any stop',
      'whose status is "pending". Everything else in the example bodies works unedited.',
      '',
      'Evidence matrix, enforced from domain/outcomes.ts. Send the wrong shape and you get 422',
      'EVIDENCE_RULES_VIOLATED with the exact violations listed, which is the most interesting',
      'thing on this endpoint to poke at:',
      '',
      '- delivered_to_person: signature required, no reason, no neighbour house number',
      '- left_with_neighbour: at least 1 photo and neighbourHouseNumber, no signature',
      '- left_safe_place: at least 1 photo (the photo is the proof), nothing else',
      '- no_answer_carded: at least 1 photo of the card, nothing else',
      '- refused: reasonCode required, no signature',
      '- access_failure: reasonCode required, no signature',
      '',
      'All six allow up to 4 photos.',
      '',
      'Idempotency: clientAttemptId is minted by the client and is the key. Sending the same id',
      'with the same body again returns 200 with deduplicated: true and writes nothing, which is',
      'what makes a handset safe to retry over a bad connection. Sending the same id with a',
      'different body returns 422 IDEMPOTENCY_PAYLOAD_MISMATCH, because that is a client bug and',
      'silently picking a winner would corrupt the record. So: change clientAttemptId whenever',
      'you change anything else.',
      '',
      'What you get back, and what to do with it. The response carries attemptId, evidenceStatus,',
      'and uploads: an array of presigned S3 PUT URLs, one per declared photo and one for the',
      'signature. Photographs never pass through this API. PUT the bytes straight to each url',
      'with the exact Content-Type and Content-Length that were declared, then call',
      'POST /api/v2/attempts/{clientAttemptId}/finalize to have the server verify them. If you',
      'declared no photos and no signature, uploads is empty and evidenceStatus is already',
      '"complete": the JSON was the whole evidence, and there is nothing to finalize.',
      '',
      'The status is 200 rather than 201 on purpose: a first write and a replay are both success',
      'and return the same shape, and a handset that cannot tell them apart is a handset that',
      'cannot safely retry.',
    ].join('\n'),
  })
  @ApiBody({
    type: CreateAttemptDto,
    description:
      'One complete attempt. Each named example below satisfies its own outcome rule and carries ' +
      'its own clientAttemptId, so you can run several in a row without them deduplicating ' +
      'against each other.',
    examples: {
      deliveredToPerson: {
        summary: 'delivered_to_person: handed over, signature taken',
        description:
          'The flagship path. Declares a signature (required for this outcome) and one photo, so ' +
          'the response comes back with two presigned PUTs and evidenceStatus "pending_media". ' +
          `${REPLACE_STOP_ID} barcodeMatch is left out deliberately: a barcode pasted into ` +
          'Swagger has not been compared against the stop you picked, and omitting the field ' +
          'says that, where false would be a claim.',
        value: {
          clientAttemptId: '3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d',
          stopId: EXAMPLE_STOP_ID,
          outcome: 'delivered_to_person',
          parcelBarcode: 'JD0114937265',
          barcodeSource: 'manual',
          note: 'Handed to the resident at the door.',
          lat: 51.5246,
          lng: -0.0996,
          gpsAccuracyM: 8,
          capturedAt: '2026-08-14T09:14:22.000Z',
          appVersion: '2.0.0',
          photos: [{ index: 0, sizeBytes: 184320 }],
          signature: { sizeBytes: 24576 },
        },
      },
      leftSafePlace: {
        summary: 'left_safe_place: photo is the proof',
        description:
          'One photo, no signature, no reason. The photo is the entire evidence for this outcome, ' +
          `so a body without one returns 422. ${REPLACE_STOP_ID}`,
        value: {
          clientAttemptId: '5c7d9e1a-2b3c-4d5e-9f01-6a7b8c9d0e1f',
          stopId: EXAMPLE_STOP_ID,
          outcome: 'left_safe_place',
          note: 'Left in the porch, out of sight from the street.',
          lat: 51.5246,
          lng: -0.0996,
          gpsAccuracyM: 11,
          capturedAt: '2026-08-14T09:31:05.000Z',
          appVersion: '2.0.0',
          photos: [{ index: 0, sizeBytes: 201430 }],
        },
      },
      leftWithNeighbour: {
        summary: 'left_with_neighbour: photo plus the house number',
        description:
          'neighbourHouseNumber is required here and forbidden on the other five outcomes, ' +
          'because it is the only thing that makes the parcel findable again. Drop it and this ' +
          `body returns 422. ${REPLACE_STOP_ID}`,
        value: {
          clientAttemptId: '7a1e4c92-3d5b-4f8a-a0c3-1b2d3e4f5061',
          stopId: EXAMPLE_STOP_ID,
          outcome: 'left_with_neighbour',
          neighbourHouseNumber: '42',
          note: 'Neighbour at 42 took it in, card left through the door.',
          lat: 51.5247,
          lng: -0.0994,
          gpsAccuracyM: 9,
          capturedAt: '2026-08-14T09:47:40.000Z',
          appVersion: '2.0.0',
          photos: [{ index: 0, sizeBytes: 176208 }],
        },
      },
      noAnswerCarded: {
        summary: 'no_answer_carded: card through the door, coming back today',
        description:
          'One photo of the card. This is one of only two outcomes where retryToday means ' +
          'anything; on the others the server stores false whatever you send, because a delivered ' +
          `or refused stop cannot answer "am I coming back". ${REPLACE_STOP_ID}`,
        value: {
          clientAttemptId: '9d3f60b1-8c27-4a5e-b6d9-2f4108c7a3be',
          stopId: EXAMPLE_STOP_ID,
          outcome: 'no_answer_carded',
          retryToday: true,
          note: 'No answer, card left. Lights on, will try again this afternoon.',
          lat: 51.5251,
          lng: -0.1002,
          gpsAccuracyM: 14,
          capturedAt: '2026-08-14T10:02:18.000Z',
          appVersion: '2.0.0',
          photos: [{ index: 0, sizeBytes: 158904 }],
        },
      },
      refused: {
        summary: 'refused: reason only, no media, completes immediately',
        description:
          'The quickest body to execute end to end: no photos and no signature means uploads ' +
          'comes back empty and evidenceStatus is already "complete", with no finalize call ' +
          `needed. reasonCode is required and a signature is forbidden. ${REPLACE_STOP_ID}`,
        value: {
          clientAttemptId: 'b4e81f27-5a63-4c9d-8f10-3e6d5a2b9c74',
          stopId: EXAMPLE_STOP_ID,
          outcome: 'refused',
          reasonCode: 'customer_refused',
          note: 'Resident said it was ordered by mistake and would not take it.',
          lat: 51.5239,
          lng: -0.0988,
          gpsAccuracyM: 7,
          capturedAt: '2026-08-14T10:19:55.000Z',
          appVersion: '2.0.0',
        },
      },
      accessFailure: {
        summary: 'access_failure: could not reach the door',
        description:
          'reasonCode required, same as refused, but this one leaves the stop retryable rather ' +
          'than settling it, so retryToday is meaningful. Also shows the no-GPS case: lat and lng ' +
          'are both omitted rather than sent as 0,0, which would record a position in the Gulf ' +
          `of Guinea as though someone had observed it. ${REPLACE_STOP_ID}`,
        value: {
          clientAttemptId: 'c81a5d39-6e42-4b7f-9a58-0d3c7e1f42a6',
          stopId: EXAMPLE_STOP_ID,
          outcome: 'access_failure',
          reasonCode: 'gate_locked',
          retryToday: true,
          note: 'Side gate padlocked, no answer on the buzzer.',
          capturedAt: '2026-08-14T10:35:02.000Z',
          appVersion: '2.0.0',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Attempt stored, or an identical replay recognised. deduplicated tells you which. PUT the ' +
      'bytes to every url in uploads, then call finalize. uploadUrlsUnavailable: true appears ' +
      'instead when presigning failed: the attempt itself is safe and durable, and you re-request ' +
      'the URLs from POST /api/v2/attempts/{clientAttemptId}/upload-urls. A conflict: true flag ' +
      'means the stop was reassigned to another driver after this attempt was captured; the ' +
      'evidence is kept and the office sees it in its conflicts queue.',
    schema: {
      example: {
        attemptId: 'e2a71c05-4f39-4d8b-9a62-31c0b7e58d14',
        clientAttemptId: '3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d',
        evidenceStatus: 'pending_media',
        deduplicated: false,
        uploads: [
          {
            kind: 'photo',
            photoIndex: 0,
            s3Key: 'attempts/3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d/0.jpg',
            url: 'https://s3.example/attempts/.../0.jpg?X-Amz-Signature=...',
            expiresInSec: 900,
          },
          {
            kind: 'signature',
            s3Key:
              'attempts/3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d/signature.png',
            url: 'https://s3.example/attempts/.../signature.png?X-Amz-Sig=...',
            expiresInSec: 900,
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The body failed structural validation: a field of the wrong type, a malformed UUID, a ' +
      'capturedAt that is not ISO 8601, or a property the DTO does not define. Unknown properties ' +
      'are rejected rather than ignored, so a typo in a field name fails loudly instead of ' +
      'silently dropping evidence.',
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired token, a token minted for the v1 surface, or an office token. Role ' +
      'and audience failures both come back as 401 here rather than 403.',
  })
  @ApiResponse({
    status: 403,
    description:
      "The stop belongs to another driver and the capture is not older than the stop's last " +
      'change, so this is someone recording work against a stop that was already not theirs. The ' +
      'reverse case (captured before the reassignment) is accepted and flagged instead, because ' +
      'refusing it would delete the only record of a real delivery. Also returned when replaying ' +
      'a clientAttemptId that belongs to a different driver, so a globally unique key cannot be ' +
      'used to probe other drivers.',
  })
  @ApiResponse({
    status: 404,
    description:
      'No stop with that id. The example stopId always lands here until you replace it.',
  })
  @ApiResponse({
    status: 422,
    description:
      'The body is structurally fine but semantically wrong. EVIDENCE_RULES_VIOLATED means the ' +
      'evidence does not match the outcome, and lists each violation. DUPLICATE_PHOTO_INDEX means ' +
      'two photos claimed the same index. IDEMPOTENCY_PAYLOAD_MISMATCH means clientAttemptId was ' +
      'reused with different content.',
    schema: {
      example: {
        code: 'EVIDENCE_RULES_VIOLATED',
        violations: ['delivered_to_person requires a signature'],
      },
    },
  })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateAttemptDto) {
    return this.attemptsService.create(user, dto);
  }

  @Post(':clientAttemptId/finalize')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify the uploaded evidence and close the attempt',
    description: [
      'Call this after PUTting every url that POST /api/v2/attempts handed back. The server runs',
      'HeadObject against S3 for each declared object and believes only what S3 reports: an',
      'object counts as verified when it is at least 1024 bytes and its length matches the size',
      'declared at submit time exactly. A few stray bytes is a failed upload, not evidence.',
      '',
      'When every photo and the signature (if one was declared) check out, evidenceStatus flips',
      'from pending_media to complete and the office is notified. Until then you get',
      'attemptComplete: false with the outstanding photos still listed as awaiting_upload, which',
      'is a status report and not an error, so it is safe to call while uploads are in flight.',
      'Re-finalizing an already complete attempt is a no-op that returns the same state.',
      '',
      SIGN_IN,
      '',
      'The path parameter is clientAttemptId: the UUID YOU minted and sent in the create body,',
      'not the server-side attemptId that came back in the response. Copy it from the',
      'clientAttemptId field of the create response if you are unsure.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'clientAttemptId',
    format: 'uuid',
    example: '3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d',
    description:
      'The client-minted UUID v4 from the create body. Must be a v4 UUID or the request is ' +
      'rejected before it reaches the handler.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Current verification state. attemptComplete: true means every declared object is in S3 ' +
      'and checked, and the evidence is closed. false means something is still outstanding: the ' +
      'photos array says which, and signatureSatisfied covers the signature.',
    schema: {
      example: {
        attemptId: 'e2a71c05-4f39-4d8b-9a62-31c0b7e58d14',
        clientAttemptId: '3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d',
        evidenceStatus: 'complete',
        attemptComplete: true,
        photos: [{ index: 0, status: 'verified' }],
        signatureSatisfied: true,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'clientAttemptId is not a v4 UUID.',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing, expired, wrong-surface, or non-driver token.',
  })
  @ApiResponse({
    status: 403,
    description:
      'The attempt exists but was written by another driver. Evidence is only readable and ' +
      'finalizable by the driver who captured it.',
  })
  @ApiResponse({
    status: 404,
    description:
      'No attempt with that clientAttemptId. Usually means the create call never landed, or the ' +
      'id was retyped rather than copied.',
  })
  finalize(
    @CurrentUser() user: JwtPayload,
    @Param('clientAttemptId', new ParseUUIDPipe({ version: '4' })) clientAttemptId: string,
  ) {
    return this.attemptsService.finalize(user, clientAttemptId);
  }

  @Post(':clientAttemptId/upload-urls')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Re-issue presigned upload URLs for an attempt',
    description: [
      'Mints fresh presigned S3 PUT URLs for whatever this attempt still owes. Use it when the',
      'URLs from the create call expired (15 minutes by default), or when create came back with',
      'uploadUrlsUnavailable: true, which means presigning failed after the attempt was already',
      'stored safely.',
      '',
      'Only unverified objects come back. A photo that finalize has already verified is not',
      're-issued, and an attempt whose evidence is complete returns an empty array. URLs expire;',
      'the attempt state does not, so this endpoint is always safe to call again.',
      '',
      SIGN_IN,
      '',
      'The path parameter is the clientAttemptId you minted for the create call. If you have not',
      'made an attempt yet, run POST /api/v2/attempts first: there is no other way to get an id',
      'that exists here.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'clientAttemptId',
    format: 'uuid',
    example: '3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d',
    description: 'The client-minted UUID v4 you sent in the create body.',
  })
  @ApiResponse({
    status: 200,
    description:
      'One entry per object still awaiting bytes. PUT to url with exactly the declared ' +
      'Content-Length and the matching Content-Type (image/jpeg for photos, image/png for the ' +
      'signature): both are baked into the signature, so anything else is rejected by S3. ' +
      'expiresInSec is how long each url lives. An empty array means nothing is outstanding.',
    schema: {
      example: [
        {
          kind: 'photo',
          photoIndex: 0,
          s3Key: 'attempts/3f2b1c8e-9a4d-4b6f-8e21-7c5d0a1b2c3d/0.jpg',
          url: 'https://s3.example/attempts/.../0.jpg?X-Amz-Signature=...',
          expiresInSec: 900,
        },
      ],
    },
  })
  @ApiResponse({
    status: 400,
    description: 'clientAttemptId is not a v4 UUID.',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing, expired, wrong-surface, or non-driver token.',
  })
  @ApiResponse({
    status: 403,
    description: 'The attempt belongs to another driver.',
  })
  @ApiResponse({
    status: 404,
    description: 'No attempt with that clientAttemptId.',
  })
  uploadUrls(
    @CurrentUser() user: JwtPayload,
    @Param('clientAttemptId', new ParseUUIDPipe({ version: '4' })) clientAttemptId: string,
  ) {
    return this.attemptsService.uploadUrls(user, clientAttemptId);
  }
}
