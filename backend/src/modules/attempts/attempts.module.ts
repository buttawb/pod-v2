import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '../media/media.module';
import { Stop } from '../stops/entities/stop.entity';
import { AttemptsController } from './attempts.controller';
import { AttemptsService } from './attempts.service';
import { AttemptPhoto } from './entities/attempt-photo.entity';
import { DeliveryAttempt } from './entities/delivery-attempt.entity';
import { PodsProjectionService } from './pods-projection.service';

@Module({
  imports: [TypeOrmModule.forFeature([DeliveryAttempt, AttemptPhoto, Stop]), MediaModule],
  controllers: [AttemptsController],
  providers: [AttemptsService, PodsProjectionService],
  exports: [AttemptsService, PodsProjectionService],
})
export class AttemptsModule {}
