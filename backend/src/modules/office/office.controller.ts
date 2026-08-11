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
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AllowQueryToken, Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { decodeCursor } from '../../common/pagination/cursor';
import { AiSummaryService } from '../ai/ai-summary.service';
import { EditSummaryDto } from './dto/edit-summary.dto';
import { OfficeService } from './office.service';

@Roles('office')
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
   */
  @AllowQueryToken()
  @Sse('feed')
  feed(@Req() req: Request): Observable<MessageEvent> {
    const lastEventId = req.headers['last-event-id'];
    const cursor = typeof lastEventId === 'string' ? decodeCursor(lastEventId) : null;
    return this.officeService.feed(cursor);
  }

  @Get('attempts')
  attempts(@Query('cursor') cursor?: string, @Query('status') status?: string) {
    const keyset = cursor ? decodeCursor(cursor) : null;
    if (cursor && !keyset) throw new BadRequestException('Malformed cursor');
    return this.officeService.listAttempts(keyset, status);
  }

  @Get('stats')
  stats() {
    return this.officeService.todayStats();
  }

  @Get('attempts/:id/summary')
  summary(@Param('id', new ParseUUIDPipe()) attemptId: string) {
    return this.aiService.getSummary(attemptId);
  }

  @Post('attempts/:id/summary/regenerate')
  regenerate(@Param('id', new ParseUUIDPipe()) attemptId: string) {
    return this.aiService.regenerate(attemptId);
  }

  @Patch('attempts/:id/summary')
  edit(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) attemptId: string,
    @Body() dto: EditSummaryDto,
  ) {
    return this.aiService.editFinal(attemptId, user.sub, dto.finalText);
  }

  /** "Send" = a named human approved this exact text. No channel integration - deliberate scope cut. */
  @Post('attempts/:id/summary/send')
  send(@CurrentUser() user: JwtPayload, @Param('id', new ParseUUIDPipe()) attemptId: string) {
    return this.aiService.markSent(attemptId, user.sub);
  }
}
