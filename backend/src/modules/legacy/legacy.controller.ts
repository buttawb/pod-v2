import { Body, Controller, Get, Param, ParseUUIDPipe, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequireAudience, Roles } from '../../common/auth/jwt-auth.guard';
import { Audience } from '../../common/auth/jwt-payload';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { LegacyPodDto } from './dto/legacy-pod.dto';
import { LegacyService } from './legacy.service';

/**
 * FROZEN v1 surface - /api/stops and /api/stops/:id/pod, exactly as the
 * live v1.4.2 fleet calls them. Guarded by golden-file contract tests; any
 * change to a byte of these responses fails the test suite.
 */
@Roles('driver')
@RequireAudience(Audience.Legacy)
@ApiTags('v1 (frozen)')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'stops', version: VERSION_NEUTRAL })
export class LegacyController {
  constructor(private readonly legacyService: LegacyService) {}

  @Get()
  @ApiOperation({
    summary: "v1 read (frozen): the driver's whole stop history, unpaginated",
    description: [
      'What a v1.4.2 handset asks for when it opens. Note the path: this is `/api/stops` with',
      'no version segment, which is a different endpoint from `/api/v2/stops`.',
      '',
      '**Precondition.** Needs a v1 token. Run **POST /api/auth/login** first, copy its `token`,',
      'and paste that into **Authorize** at the top of this page. A v2 token from',
      '`/api/v2/auth/driver/login` gets a 401 here: the two surfaces do not share tokens.',
      '',
      '**How to run it.** With the v1 token authorized, press *Try it out* then *Execute*.',
      'There is nothing to fill in. Then take any `id` from the response whose `pod` is `null`',
      'and use it as the `{id}` path parameter on **POST /api/stops/{id}/pod** below.',
      '',
      '**Contract properties, all deliberate**',
      '',
      '- The whole history comes back in one array. There is no paging, no limit, no cursor,',
      '  and no filter to today. v1.4.2 filters to today on the handset, so narrowing it here',
      '  would empty screens in the field. The unboundedness is a known cost of not breaking',
      '  the fleet, and is watched rather than fixed.',
      '- Query parameters are ignored, not honoured. `?limit=5` returns the same array as no',
      '  query at all, because a v1 client that thinks it paged and did not would silently drop',
      '  stops.',
      '- Each stop carries exactly seven keys plus `pod`, and no more. The v2 columns on the',
      '  same table (status, lat, lng and the rest) are filtered out by an explicit field list,',
      '  so adding a column to the database cannot leak into this response. A test asserts the',
      '  exact key set.',
      '- `pod` is `null` until a POD has been submitted for that stop, and only ever one object,',
      '  never a list. A stop holds at most one POD in the v1 schema.',
      '- Newest first, and within the same timestamp in round order.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description:
      "The driver's full stop history, newest first. Pick an id whose pod is null to try the POD submission below.",
    schema: {
      type: 'array',
      example: [
        {
          id: '14d9f5a2-1b2c-4250-b84a-8db1060aa7d4',
          driver_id: '7f3e9b21-33d0-4a1c-92c5-b30876d4e102',
          address: '12 Brick Lane',
          postcode: 'E1 6RF',
          location: '51.5203,-0.0715',
          sequence: 1,
          created_at: '2026-08-14T06:12:04.318Z',
          pod: null,
        },
        {
          id: '4e6a0f92-5c3b-49d7-8a21-b0d94f7c6e35',
          driver_id: '7f3e9b21-33d0-4a1c-92c5-b30876d4e102',
          address: '48 Hoxton Street',
          postcode: 'N1 6SH',
          location: '51.5312,-0.0784',
          sequence: 2,
          created_at: '2026-08-14T06:31:47.902Z',
          pod: {
            id: '9c1f7a08-2d64-4b93-a5e7-1f83c0b6d472',
            stop_id: '4e6a0f92-5c3b-49d7-8a21-b0d94f7c6e35',
            delivered: true,
            photo_url: 'https://legacy-cdn.example.com/pods/9c1f7a08.jpg',
            signature_url: null,
            location: '51.5312,-0.0784',
            note: 'Left in porch',
            created_at: '2026-08-14T06:33:10.551Z',
          },
        },
      ],
    },
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired one, or a v2 token used on a v1 route. Tokens carry the surface they were minted for, so the v2 one is refused here even though it is valid: get a v1 token from POST /api/auth/login.',
  })
  getStops(@CurrentUser() user: JwtPayload) {
    return this.legacyService.getStops(user);
  }

  @Post(':id/pod')
  @ApiOperation({
    summary: 'v1 write (frozen): submit the POD for one stop, once',
    description: [
      'The one write a v1.4.2 handset makes. Underneath it becomes a v2 delivery attempt with',
      'the raw v1 body kept verbatim, but nothing about that is visible here: the request and',
      'the response are the v1 ones.',
      '',
      '**Preconditions.** Two things, in this order:',
      '',
      '1. A v1 token from **POST /api/auth/login**, pasted into **Authorize** at the top of the',
      '   page. A v2 token is rejected with 401.',
      '2. A stop `id`. There is no example id that will work, because stop ids are generated',
      '   when the demo data is seeded. Call **GET /api/stops** above, pick a stop whose `pod`',
      '   is `null`, and paste its `id` into the `id` box. It has to be one of your own stops:',
      "   another driver's stop answers 403.",
      '',
      '**How to run it.** Press *Try it out*, paste the stop id into `id`, leave the pre-filled',
      'body alone, press *Execute*. You should get 201 and the created POD back. Press *Execute*',
      'a second time and you should get 409, which is the frozen duplicate behaviour rather than',
      'an error on your part.',
      '',
      '**Contract properties, all deliberate**',
      '',
      '- 201 the first time for a stop, 409 every time after. A stop holds exactly one POD in',
      '  the v1 schema, and v1.4.2 shows a generic error on 409. Answering 201 again would tell',
      '  the handset a second POD exists when the schema cannot hold one.',
      '- The response is the POD row itself, in snake_case, with the same key set the handset',
      '  parses. It reads `id` and `created_at` off it in the field.',
      '- The field names in the body are snake_case for the same reason: they are what the',
      '  handsets send, and unknown keys are rejected rather than ignored.',
      '- The response never depends on internal flags. If the projection that fills the v1 pods',
      '  table is switched off, the same shape is synthesised from the recorded attempt, because',
      '  an internal toggle must never turn into a 500 for a fleet we promised not to break.',
      '',
      '**Retries.** An identical body resent for the same stop within about five minutes is',
      'recognised as a network retry and does not create a second attempt underneath, although',
      'the surface still answers 409. Change the note and it is a genuinely different event.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description:
      'The stop to attach this POD to, as a UUID. The value shown is a placeholder for the shape only and will answer 404: replace it with a real id from GET /api/stops above, ideally one whose pod is null, since a stop that already has one answers 409. It must be a stop on your own round.',
    example: '14d9f5a2-1b2c-4250-b84a-8db1060aa7d4',
    format: 'uuid',
  })
  @ApiBody({
    type: LegacyPodDto,
    description:
      'The frozen v1 POD body. Only delivered is required; the rest describe the evidence the handset captured. Send it as is, or pick one of the variants below.',
    examples: {
      deliveredWithPhoto: {
        summary: 'Delivered, photo only (recorded as left_safe_place)',
        description:
          'The default. Executable unedited once you have pasted a stop id, and the case most v1 rounds produce.',
        value: {
          delivered: true,
          photo_url: 'https://legacy-cdn.example.com/pods/demo-photo.jpg',
          location: '51.5074,-0.1278',
          note: 'Left in porch, photo taken',
        },
      },
      deliveredWithSignature: {
        summary: 'Delivered, signature captured (recorded as delivered_to_person)',
        description: 'A signature is the evidence that proves a person actually took the parcel.',
        value: {
          delivered: true,
          signature_url: 'https://legacy-cdn.example.com/pods/demo-signature.png',
          location: '51.5074,-0.1278',
          note: 'Handed to resident at front door',
        },
      },
      notDelivered: {
        summary: 'Nobody in (recorded as no_answer_carded)',
        description: 'delivered=false, so no evidence is expected and none is required.',
        value: {
          delivered: false,
          location: '51.5074,-0.1278',
          note: 'No answer, card left',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'The POD was recorded. The body is the created POD row, which is what v1.4.2 reads id and created_at from. Submitting again for this stop now answers 409.',
    schema: {
      example: {
        id: '9c1f7a08-2d64-4b93-a5e7-1f83c0b6d472',
        stop_id: '14d9f5a2-1b2c-4250-b84a-8db1060aa7d4',
        delivered: true,
        photo_url: 'https://legacy-cdn.example.com/pods/demo-photo.jpg',
        signature_url: null,
        location: '51.5074,-0.1278',
        note: 'Left in porch, photo taken',
        created_at: '2026-08-14T09:41:22.107Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The id in the path is not a UUID, or the body has a bad type or an unrecognised key. Unknown keys are rejected rather than dropped, which is what keeps this body frozen.',
  })
  @ApiResponse({
    status: 401,
    description:
      'No token, an expired one, or a v2 token on a v1 route. Sign in at POST /api/auth/login for the token this endpoint accepts.',
  })
  @ApiResponse({
    status: 403,
    description:
      "The stop exists but is on another driver's round. A driver can only submit evidence for their own stops.",
  })
  @ApiResponse({
    status: 404,
    description:
      'No stop with that id. The id is a valid UUID but nothing matches it, so recheck it against GET /api/stops.',
  })
  @ApiResponse({
    status: 409,
    description:
      'This stop already has a POD. A stop can hold exactly one, so a second submission is refused instead of overwriting the first. Evidence here is added, never edited: use a different stop.',
  })
  submitPod(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) stopId: string,
    @Body() dto: LegacyPodDto,
  ) {
    return this.legacyService.submitPod(user, stopId, dto);
  }
}
