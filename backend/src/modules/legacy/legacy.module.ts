import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttemptsModule } from '../attempts/attempts.module';
import { Stop } from '../stops/entities/stop.entity';
import { Pod } from './entities/pod.entity';
import { LegacyController } from './legacy.controller';
import { LegacyService } from './legacy.service';

@Module({
  imports: [TypeOrmModule.forFeature([Stop, Pod]), AttemptsModule],
  controllers: [LegacyController],
  providers: [LegacyService],
})
export class LegacyModule {}
