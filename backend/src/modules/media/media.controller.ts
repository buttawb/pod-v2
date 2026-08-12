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
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../../common/auth/jwt-payload';
import { AttemptPhoto } from '../attempts/entities/attempt-photo.entity';
import { DeliveryAttempt } from '../attempts/entities/delivery-attempt.entity';
import { S3Service } from './s3.service';

/**
 * Every evidence view passes authz here and 302s to a fresh short-TTL
 * presigned GET. Nothing durable ever stores a presigned URL, and the
 * bucket stays fully private.
 */
@Roles('driver', 'office')
@ApiTags('media')
@Controller({ path: 'media', version: '2' })
export class MediaController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly s3: S3Service,
  ) {}

  @Get('attempts/:attemptId/photo/:index')
  @Redirect(undefined, 302)
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
