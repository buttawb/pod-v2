import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { S3Service } from './s3.service';

@Module({
  controllers: [MediaController],
  providers: [S3Service],
  exports: [S3Service],
})
export class MediaModule {}
