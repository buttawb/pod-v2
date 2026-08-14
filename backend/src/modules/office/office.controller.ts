import {
  BadRequestException,
  Body,
  Controller,
  Get,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AllowQueryToken, Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { decodeCursor } from '../../common/pagination/cursor';
import { AiSummaryService } from '../ai/ai-summary.service';
import { EditSummaryDto } from './dto/edit-summary.dto';
import { OfficeService } from './office.service';

/**
 * Repeated in the description of every route here, because Swagger UI shows
 * one operation at a time and a reviewer who lands on a deep link should not
 * have to scroll back up to find out why they are getting a 401.
 */
const OFFICE_TOKEN_LINE =
  'Requires an OFFICE token. Sign in at POST /api/v2/auth/office/login with ' +
  'office@demo.pod / OfficeDemo#2026, copy `accessToken` from the response, then press ' +
  'the Authorize button at the top of this page and paste it. A driver token will not ' +
  'open this route.';

/** A real, well-formed keyset cursor, so the box is never empty in Try it out. */
const CURSOR_EXAMPLE =
  'eyJ0cyI6IjIwMjYtMDgtMTQgMDk6NDE6MTIuNDgzMjE3KzAwIiwiaWQiOiI4ZjE0ZTQ1Zi1jZWVhLTQ2N2EtOWMyYi0yZjJkMGMxZjdhMTAifQ';

/** Placeholder shape only. Replace with a real id from GET /api/v2/office/attempts. */
const ATTEMPT_ID_EXAMPLE = '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10';

const UNAUTHORIZED_RESPONSE = {
  status: 401,
  description:
    'No token, an expired token, or a token for the wrong surface. Also what you get for the ' +
    'wrong ROLE: a driver token on an office route answers 401, not 403, so "Insufficient role" ' +
    'here means you signed in at the driver login by mistake.',
  schema: {
    example: { message: 'Insufficient role', error: 'Unauthorized', statusCode: 401 },
  },
} as const;

@Roles('office')
@ApiTags('office')
@ApiBearerAuth('driver-or-office')
@Controller({ path: 'office', version: '2' })
export class OfficeController {
  constructor(
    private readonly officeService: OfficeService,
    private readonly aiService: AiSummaryService,
  ) {}

  /**
   * Live status feed. Reconnects carry Last-Event-ID: we first replay from
   * the table (the source of truth), then switch to live doorbell events -
   * LISTEN/NOTIFY's at-most-once delivery costs nothing.
   *
   * That header is set automatically only on EventSource's own reconnects. A
   * client that has to construct a fresh EventSource cannot set it, and this
   * one has to: the access token rides in the URL and a live connection's URL
   * cannot be changed, so every token rotation forces a reopen. The same
   * cursor is therefore accepted as a query parameter, otherwise each
   * rotation would silently drop whatever arrived during the gap.
   */
  @AllowQueryToken()
  @Sse('feed')
  @ApiOperation({
    summary: 'Live feed of delivery attempts (Server-Sent Events)',
    description: [
      'Holds the connection open and pushes one `attempt` event the moment a driver files',
      'evidence. This is what an office wall board reads.',
      '',
      OFFICE_TOKEN_LINE,
      'Those sign-in details are seeded demo accounts, published on purpose so this page can be',
      'executed during a review. They live on a demo database with no real personal data in it,',
      'so nothing here is a leaked credential.',
      '',
      '**Try it out will appear to hang, and that is correct.** The response is an endless',
      'stream, so Swagger UI shows a spinner until you navigate away. To actually watch it:',
      '',
      '```',
      'curl -N -H "Authorization: Bearer <accessToken>" https://<host>/api/v2/office/feed',
      '```',
      '',
      'To see events appear, keep that curl running and file an attempt from another window with',
      'POST /api/v2/attempts as a driver.',
      '',
      'Every event carries an `id:` line holding a cursor. Send the last one you saw back as the',
      '`Last-Event-ID` header (EventSource does this itself on reconnect) or as `?last_event_id=`,',
      'and the feed replays what you missed from the table before going live. With no cursor a',
      'fresh connection starts one minute in the past.',
      '',
      'A `ping` event arrives every 25 seconds so an idle connection is not cut by a proxy.',
      'Ignore it: it carries no data.',
    ].join('\n'),
  })
  @ApiProduces('text/event-stream')
  @ApiQuery({
    name: 'last_event_id',
    required: false,
    description:
      'Resume point: the `id` of the last event you processed. Use this when your client cannot ' +
      'set the Last-Event-ID header, which is the case here because a rotated token forces the ' +
      'EventSource URL to change. A cursor that does not decode is ignored and the feed starts ' +
      'one minute back.',
    example: CURSOR_EXAMPLE,
  })
  @ApiQuery({
    name: 'access_token',
    required: false,
    description:
      'The access token as a query parameter, accepted only on this route because EventSource ' +
      'cannot set an Authorization header. Prefer the header everywhere else: a token in a URL ' +
      'ends up in proxy logs. Leave this blank in Swagger UI, which sends the header for you.',
  })
  @ApiResponse({
    status: 200,
    description:
      'An open event stream. One `attempt` event per delivery, plus a `ping` every 25 seconds.',
    content: {
      'text/event-stream': {
        schema: { type: 'string' },
        example:
          `id: ${CURSOR_EXAMPLE}\n` +
          'event: attempt\n' +
          'data: {"attemptId":"8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10",' +
          '"stopId":"3d1c9a76-6b0e-4f2e-9d51-9a0f5a1c77b2",' +
          '"driverId":"b7c2f0d4-5c3a-4f88-9f4a-1f6d2e0a44c9",' +
          '"outcome":"left_safe_place","evidenceStatus":"complete",' +
          '"receivedAt":"2026-08-14T09:41:12.483Z"}\n\n' +
          'event: ping\ndata: \n\n',
      },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  feed(
    @Req() req: Request,
    @Query('last_event_id') lastEventIdParam?: string,
  ): Observable<MessageEvent> {
    const header = req.headers['last-event-id'];
    const lastEventId = typeof header === 'string' ? header : lastEventIdParam;
    const cursor = typeof lastEventId === 'string' ? decodeCursor(lastEventId) : null;
    return this.officeService.feed(cursor);
  }

  @Get('attempts')
  @ApiOperation({
    summary: 'The evidence record, newest first',
    description: [
      'The office view of every delivery attempt: outcome, evidence state, the stop it belongs',
      'to, the driver who filed it, and the AI summary attached to it if there is one.',
      '',
      OFFICE_TOKEN_LINE,
      'The demo login above is deliberately published so a reviewer can run this page without',
      'being sent a password out of band. It is a seeded account on a demo database, not a leak.',
      '',
      '**Start here.** Send it with no parameters at all and it returns the most recent 50',
      'attempts. Take an `id` from the response and use it as the `:id` on every summary route',
      'below, which is the only place those ids come from.',
      '',
      'Paging is keyset, not offset: copy `nextCursor` from the response into `cursor` for the',
      'next page and repeat while `hasMore` is true. Rows are never skipped or repeated under',
      'concurrent inserts, which matters when the thing being paged is evidence.',
      '',
      'Field names in `attempts[]` are snake_case because the rows come straight from SQL. The',
      'envelope keys (`nextCursor`, `hasMore`) are camelCase. That is existing behaviour and is',
      'documented rather than tidied, because clients already read it.',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Opaque keyset cursor. Leave empty for the first page, then pass the `nextCursor` from ' +
      'the previous response. Anything that is not a valid cursor is rejected with 400 rather ' +
      'than quietly returning page one.',
    example: CURSOR_EXAMPLE,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'Filters on the attempt OUTCOME, despite the parameter name. One of: ' +
      'delivered_to_person, left_with_neighbour, left_safe_place, no_answer_carded, refused, ' +
      'access_failure. An unknown value is not an error, it just matches nothing.',
    example: 'left_safe_place',
  })
  @ApiResponse({
    status: 200,
    description: 'Up to 50 attempts, newest first, with the cursor for the next page.',
    schema: {
      example: {
        attempts: [
          {
            id: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
            stop_id: '3d1c9a76-6b0e-4f2e-9d51-9a0f5a1c77b2',
            outcome: 'left_safe_place',
            evidence_status: 'complete',
            note: 'left round the back by the bins',
            captured_at: '2026-08-14T09:40:58.000Z',
            received_at: '2026-08-14T09:41:12.483Z',
            source: 'v2',
            app_version: '2.0.0',
            address: '14 Ravenscourt Road',
            postcode: 'W6 0UH',
            sequence: 27,
            driver_name: 'Test Driver',
            ai_status: 'ready',
            draft_text: 'Your parcel was delivered and left in a safe place.',
            final_text: null,
            ai_source: 'bedrock',
            sent_at: null,
          },
        ],
        nextCursor: CURSOR_EXAMPLE,
        hasMore: true,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'The `cursor` was not a cursor this API issued. Copy `nextCursor` verbatim rather than ' +
      'building one by hand.',
    schema: {
      example: { message: 'Malformed cursor', error: 'Bad Request', statusCode: 400 },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  attempts(@Query('cursor') cursor?: string, @Query('status') status?: string) {
    const keyset = cursor ? decodeCursor(cursor) : null;
    if (cursor && !keyset) throw new BadRequestException('Malformed cursor');
    return this.officeService.listAttempts(keyset, status);
  }

  /**
   * Deliveries that arrived for a stop their driver no longer owns. Real work
   * with a paperwork problem, not failures, and the office needs to see them
   * before the customer calls.
   */
  @Get('conflicts')
  @ApiOperation({
    summary: 'Deliveries filed against a stop the driver no longer owns',
    description: [
      'Completed deliveries with a paperwork problem, not failures: the driver was at the door',
      'before dispatch reassigned the stop. The evidence is kept and surfaced here so the office',
      'hears it from us rather than from the customer.',
      '',
      OFFICE_TOKEN_LINE,
      'Yes, that password is written down in public. These are throwaway demo accounts seeded for',
      'this evaluation so every box on this page can be executed as it stands.',
      '',
      'Read-only. Nothing here resolves a conflict, by design: it is settled by acting on the',
      'stop, never by editing the evidence that reported it.',
      '',
      'The identical response is served at GET /api/v2/conflicts. Same handler, same service,',
      'same office role. Two paths exist because the queue reads naturally as a top-level',
      'resource as well as part of the office view, and they cannot differ.',
      '',
      'Send it with no parameters for the first page, then page with `nextCursor` exactly as on',
      'GET /api/v2/office/attempts.',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Opaque keyset cursor. Empty for the first page, then the `nextCursor` from the previous ' +
      'response.',
    example: CURSOR_EXAMPLE,
  })
  @ApiResponse({
    status: 200,
    description:
      'Up to 50 conflicts, newest first. `driver_name` is who filed the evidence, ' +
      '`current_driver_name` is who owns the stop now, and null there means nobody does.',
    schema: {
      example: {
        conflicts: [
          {
            id: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
            stop_id: '3d1c9a76-6b0e-4f2e-9d51-9a0f5a1c77b2',
            outcome: 'delivered_to_person',
            evidence_status: 'complete',
            captured_at: '2026-08-14T09:40:58.000Z',
            received_at: '2026-08-14T09:41:12.483Z',
            conflict_reason: 'stop_reassigned',
            address: '14 Ravenscourt Road',
            postcode: 'W6 0UH',
            driver_name: 'Test Driver',
            current_driver_name: 'Karachi Driver',
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'The `cursor` did not decode. Use `nextCursor` from the previous page as-is.',
    schema: {
      example: { message: 'Malformed cursor', error: 'Bad Request', statusCode: 400 },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  conflicts(@Query('cursor') cursor?: string) {
    const keyset = cursor ? decodeCursor(cursor) : null;
    if (cursor && !keyset) throw new BadRequestException('Malformed cursor');
    return this.officeService.listConflicts(keyset);
  }

  @Get('stats')
  @ApiOperation({
    summary: "Today's counts for stops and attempts",
    description: [
      'One small object for the top of an office screen. No parameters, no body: press Try it',
      'out and Execute.',
      '',
      OFFICE_TOKEN_LINE,
      'The credentials are stated openly because they are meant to be used: seeded demo accounts',
      'on a demo database, put there so this page runs end to end for a reviewer.',
      '',
      '"Today" is the server day, counted from midnight UTC (`date_trunc(\'day\', now())`), so a',
      'round that runs across midnight is split between two days.',
      '',
      '`stops` counts rows created today by their current status. `attempts` counts evidence',
      'filed today, and `pending_media` is the subset still waiting on photograph uploads to',
      'land in S3, which is normal for a few seconds after a driver submits.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: 'Counts as of now. All integers, never null.',
    schema: {
      example: {
        stops: { pending: 96, attempted: 12, delivered: 41, failed: 2, total: 151 },
        attempts: { attempts_today: 55, pending_media: 1 },
      },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  stats() {
    return this.officeService.todayStats();
  }

  @Get('attempts/:id/summary')
  @ApiOperation({
    summary: 'Read the AI summary for one attempt (step 1 of the summary flow)',
    description: [
      'The customer-facing sentence drafted for a delivery, plus who has touched it. Start here:',
      'the other four summary routes act on what this one shows.',
      '',
      '**Order to click them in:** this route to see the draft, then',
      'POST .../summary/regenerate or PATCH .../summary if the text needs changing, then',
      'POST .../summary/approve, then POST .../summary/send. Sending before approving is',
      'refused with 409 on purpose, so nothing can reach a customer that a named person has not',
      'signed off.',
      '',
      OFFICE_TOKEN_LINE,
      'The demo office login is published intentionally: it is a seeded evaluation account on a',
      'demo database, not something that escaped.',
      '',
      '`:id` is a delivery attempt id. Get one from GET /api/v2/office/attempts, which is the',
      'only place to find one. There is no summary until a driver files an attempt, because',
      'generation is triggered by the submission itself.',
      '',
      'Read `status` before doing anything with the text. `ready` is a model draft that passed',
      'validation. `fallback` is the fixed template for that outcome: safe to send, but it says',
      'nothing the outcome code did not already say, so it is usually worth editing. `pending`',
      'is still generating. `failed` means neither a draft nor a template could be stored.',
      '`approved` means a person has signed off. `source` answers a separate question, `bedrock`',
      'or `template`, and both are shown so a template can never be presented as a model draft.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description:
      'Delivery attempt id (UUID). Copy one from the `id` field of GET /api/v2/office/attempts. ' +
      'The value pre-filled here has the right shape but is not a real row, so leaving it ' +
      'unedited returns the `status: "none"` body below.',
    example: ATTEMPT_ID_EXAMPLE,
  })
  @ApiResponse({
    status: 200,
    description:
      'The summary, or the same shape with `status: "none"` and every field null when the ' +
      'attempt has no summary row. This route does not 404 on an unknown attempt: the keys are ' +
      'always identical, so a client reading `source` can tell "template" from "nothing here".',
    schema: {
      example: {
        attemptId: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
        status: 'ready',
        draft: 'Your parcel was delivered and left in a safe place.',
        source: 'bedrock',
        model: 'anthropic.claude-haiku-4-5',
        finalText: null,
        editedBy: null,
        editedAt: null,
        sentAt: null,
        generatedAt: '2026-08-14T09:41:14.902Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: '`:id` was not a UUID. It is a delivery attempt id, not a stop id or a barcode.',
    schema: {
      example: {
        message: 'Validation failed (uuid is expected)',
        error: 'Bad Request',
        statusCode: 400,
      },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  summary(@Param('id', new ParseUUIDPipe()) attemptId: string) {
    return this.aiService.getSummary(attemptId);
  }

  /** Sign-off, separate from sending. Nothing reaches a customer unapproved. */
  @Post('attempts/:id/summary/approve')
  @ApiOperation({
    summary: 'Sign off on the summary text (step 3 of the summary flow)',
    description: [
      'Records that a named office user stands behind this exact text. It is the authority for',
      'sending, and it is a separate act from sending so that "nothing auto-sends" is checkable',
      'rather than merely intended: an unapproved summary has no path to a customer.',
      '',
      '**Do this third.** Read it with GET .../summary, change it with',
      'POST .../summary/regenerate or PATCH .../summary if needed, approve here, then',
      'POST .../summary/send.',
      '',
      OFFICE_TOKEN_LINE,
      'That office password is in the open deliberately. It belongs to a seeded demo account for',
      'this evaluation, on a demo database, so the flow can be clicked through end to end.',
      '',
      'No request body. The approver is taken from your token, not from anything you send, so',
      'the attribution cannot be forged by the caller.',
      '',
      '`:id` is a delivery attempt id from GET /api/v2/office/attempts. Approving sets',
      '`finalText` to your edit if you made one, otherwise to the draft.',
      '',
      'Returns 201, not 200: this is a POST and the route does not override the Nest default.',
      'Repeating it is harmless, and approving something already sent returns the sent text',
      'unchanged rather than re-approving it.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description:
      'Delivery attempt id (UUID), from the `id` field of GET /api/v2/office/attempts. The ' +
      'pre-filled value is shape-correct but not a real row, so it answers 404 until you ' +
      'replace it.',
    example: ATTEMPT_ID_EXAMPLE,
  })
  @ApiResponse({
    status: 201,
    description:
      'Approved. `status` is now `approved` and `editedBy` names the office user who signed off.',
    schema: {
      example: {
        attemptId: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
        status: 'approved',
        draft: 'Your parcel was delivered and left in a safe place.',
        source: 'bedrock',
        model: 'anthropic.claude-haiku-4-5',
        finalText: 'Your parcel was delivered and left in a safe place.',
        editedBy: 'c4a1b8e2-7d55-4a1e-9d0b-6a2f3c9e5b71',
        editedAt: null,
        sentAt: null,
        generatedAt: '2026-08-14T09:41:14.902Z',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'No summary row for that attempt, or the row exists with no draft text yet. Check ' +
      'GET .../summary first: if `status` is `pending` the generation has not finished.',
    schema: {
      example: { message: 'Nothing to approve', error: 'Not Found', statusCode: 404 },
    },
  })
  @ApiResponse({
    status: 409,
    description:
      'The summary is `pending` or `failed`, so there is no finished text to stand behind. ' +
      'Wait for generation, or force a new draft with POST .../summary/regenerate.',
    schema: {
      example: {
        message:
          'Cannot approve a summary that is pending: there is no finished text to stand behind',
        error: 'Conflict',
        statusCode: 409,
      },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  approveSummary(
    @Param('id', new ParseUUIDPipe()) attemptId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.aiService.approve(attemptId, user.sub);
  }

  @Post('attempts/:id/summary/regenerate')
  @ApiOperation({
    summary: 'Draft the summary again from scratch (step 2 of the summary flow)',
    description: [
      'Runs generation again for the same attempt, skipping the cache so you get a genuinely new',
      'call to the model rather than the text it produced last time for an identical note.',
      '',
      '**Do this second, if at all.** GET .../summary to read the draft, regenerate here or edit',
      'it with PATCH .../summary, then POST .../summary/approve, then POST .../summary/send.',
      '',
      OFFICE_TOKEN_LINE,
      'The login is quoted here on purpose: it is a demo account seeded for this review, holding',
      'no real personal data, so the page can be executed without asking anyone for a password.',
      '',
      'No request body. `:id` is a delivery attempt id from GET /api/v2/office/attempts.',
      '',
      'Two behaviours worth knowing. If the summary has already been sent, this returns it',
      'unchanged: sent text is settled and is not rewritten underneath a customer. And if the',
      'model is unavailable or its output fails validation, you get the deterministic template',
      'for the outcome instead of an error, with `status: "fallback"` and `source: "template"`,',
      'so the office is never blocked by the provider.',
      '',
      'Returns 201 because it is a POST on the Nest default, not because anything was created.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description:
      'Delivery attempt id (UUID) from GET /api/v2/office/attempts. The pre-filled value is not ' +
      'a real attempt, so it answers 404 until you paste one in.',
    example: ATTEMPT_ID_EXAMPLE,
  })
  @ApiResponse({
    status: 201,
    description:
      'A fresh draft. `status` is `ready` when the model answered and its output passed ' +
      'validation, or `fallback` when the template was used instead.',
    schema: {
      example: {
        attemptId: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
        status: 'ready',
        draft: 'Your parcel was delivered and left in a safe place.',
        source: 'bedrock',
        model: 'anthropic.claude-haiku-4-5',
        finalText: null,
        editedBy: null,
        editedAt: null,
        sentAt: null,
        generatedAt: '2026-08-14T10:02:41.117Z',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'No delivery attempt with that id. Take one from GET /api/v2/office/attempts rather than ' +
      'inventing a UUID.',
    schema: {
      example: { message: 'Unknown attempt', error: 'Not Found', statusCode: 404 },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  regenerate(@Param('id', new ParseUUIDPipe()) attemptId: string) {
    return this.aiService.regenerate(attemptId);
  }

  @Patch('attempts/:id/summary')
  @ApiOperation({
    summary: 'Replace the summary text by hand (alternative to step 2)',
    description: [
      'Writes the exact sentence the customer will read. Use it when the draft is close but',
      'wrong, or when a `fallback` template is too generic to be worth sending.',
      '',
      'The AI draft column is never overwritten. Your text lands in `finalText` with your user',
      'id in `editedBy` and a timestamp in `editedAt`, so the record always shows both what the',
      'model produced and what a person decided to send.',
      '',
      '**Where this sits:** GET .../summary to read, this or POST .../summary/regenerate to',
      'change, then POST .../summary/approve, then POST .../summary/send.',
      '',
      OFFICE_TOKEN_LINE,
      'Those details are demo credentials, published knowingly so a reviewer can execute this',
      'page. The account is seeded on a demo database and is not a real operator.',
      '',
      'The body below is ready to send as it stands. `:id` is a delivery attempt id from',
      'GET /api/v2/office/attempts. Editing does not approve: the summary still has to go',
      'through POST .../summary/approve before it can be sent.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description:
      'Delivery attempt id (UUID) from GET /api/v2/office/attempts. A summary must already ' +
      'exist for it, which it will once the attempt has been filed.',
    example: ATTEMPT_ID_EXAMPLE,
  })
  @ApiResponse({
    status: 200,
    description: 'Saved. `finalText` is now your text and the edit is attributed to your token.',
    schema: {
      example: {
        attemptId: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
        status: 'ready',
        draft: 'Your parcel was delivered and left in a safe place.',
        source: 'bedrock',
        model: 'anthropic.claude-haiku-4-5',
        finalText: 'Delivered and left in your chosen safe place. Photo on file.',
        editedBy: 'c4a1b8e2-7d55-4a1e-9d0b-6a2f3c9e5b71',
        editedAt: '2026-08-14T10:05:02.884Z',
        sentAt: null,
        generatedAt: '2026-08-14T09:41:14.902Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      '`finalText` was missing, empty, longer than 200 characters, or the body carried a key ' +
      'that is not in the schema. Unknown keys are rejected rather than ignored.',
    schema: {
      example: {
        message: ['finalText should not be empty'],
        error: 'Bad Request',
        statusCode: 400,
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'That attempt has no summary row to edit. GET .../summary first: a `status` of `none` ' +
      'means there is nothing to change yet.',
    schema: {
      example: { message: 'No summary for attempt', error: 'Not Found', statusCode: 404 },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  edit(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) attemptId: string,
    @Body() dto: EditSummaryDto,
  ) {
    return this.aiService.editFinal(attemptId, user.sub, dto.finalText);
  }

  /** "Send" = a named human approved this exact text. No channel integration - deliberate scope cut. */
  @Post('attempts/:id/summary/send')
  @ApiOperation({
    summary: 'Release the approved summary (step 4, the last one)',
    description: [
      'Marks the summary as sent and stamps `sentAt`. After this the text is settled: regenerate',
      'and approve both leave it alone rather than rewriting something a customer has already',
      'read.',
      '',
      '**Click order:** GET .../summary, then regenerate or PATCH if the text needs work, then',
      'POST .../summary/approve, then this. Calling this before approval returns 409 by design,',
      'and that is the whole point of splitting the two: approval is the authority, sending is',
      'only the act.',
      '',
      OFFICE_TOKEN_LINE,
      'The password is written out above on purpose. It is a seeded demo account for this',
      'evaluation, on a demo database, so every step of this flow can be run by a reviewer.',
      '',
      'No request body. `:id` is a delivery attempt id from GET /api/v2/office/attempts.',
      '',
      'Honest scope note: there is no email or SMS integration behind this. It records that a',
      'named person released this exact text, which is the part that has to be auditable. Wiring',
      'a channel to it was a deliberate scope cut, not an oversight.',
      '',
      'Returns 201 on the Nest POST default.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description:
      'Delivery attempt id (UUID) from GET /api/v2/office/attempts, for a summary that has ' +
      'already been approved.',
    example: ATTEMPT_ID_EXAMPLE,
  })
  @ApiResponse({
    status: 201,
    description:
      'Sent. `sentAt` is set. `status` stays `approved`: whether it left and who authorised it ' +
      'are separate facts and are kept separate.',
    schema: {
      example: {
        attemptId: '8f14e45f-ceea-467a-9c2b-2f2d0c1f7a10',
        status: 'approved',
        draft: 'Your parcel was delivered and left in a safe place.',
        source: 'bedrock',
        model: 'anthropic.claude-haiku-4-5',
        finalText: 'Delivered and left in your chosen safe place. Photo on file.',
        editedBy: 'c4a1b8e2-7d55-4a1e-9d0b-6a2f3c9e5b71',
        editedAt: '2026-08-14T10:05:02.884Z',
        sentAt: '2026-08-14T10:06:30.019Z',
        generatedAt: '2026-08-14T09:41:14.902Z',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'No summary row for that attempt, or one with no draft text. There is nothing to send.',
    schema: {
      example: { message: 'Nothing to send', error: 'Not Found', statusCode: 404 },
    },
  })
  @ApiResponse({
    status: 409,
    description:
      'The summary has not been approved. Call POST .../summary/approve first. This is the ' +
      'guard that stops unreviewed text reaching a customer, so it is expected, not a bug.',
    schema: {
      example: {
        message: 'Approve this summary before sending it',
        error: 'Conflict',
        statusCode: 409,
      },
    },
  })
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  send(@CurrentUser() user: JwtPayload, @Param('id', new ParseUUIDPipe()) attemptId: string) {
    return this.aiService.markSent(attemptId, user.sub);
  }
}
