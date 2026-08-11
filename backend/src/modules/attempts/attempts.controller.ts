import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { AttemptsService } from './attempts.service';
import { CreateAttemptDto } from './dto/create-attempt.dto';

@Roles('driver')
@Controller({ path: 'attempts', version: '2' })
export class AttemptsController {
  constructor(private readonly attemptsService: AttemptsService) {}

  @Post()
  @HttpCode(200) // replays return the same shape as first delivery - both are "success"
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateAttemptDto) {
    return this.attemptsService.create(user, dto);
  }

  @Post(':clientAttemptId/finalize')
  @HttpCode(200)
  finalize(
    @CurrentUser() user: JwtPayload,
    @Param('clientAttemptId', new ParseUUIDPipe({ version: '4' })) clientAttemptId: string,
  ) {
    return this.attemptsService.finalize(user, clientAttemptId);
  }

  @Post(':clientAttemptId/upload-urls')
  @HttpCode(200)
  uploadUrls(
    @CurrentUser() user: JwtPayload,
    @Param('clientAttemptId', new ParseUUIDPipe({ version: '4' })) clientAttemptId: string,
  ) {
    return this.attemptsService.uploadUrls(user, clientAttemptId);
  }
}
