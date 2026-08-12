import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttemptsModule } from '../attempts/attempts.module';
import { Driver } from '../drivers/entities/driver.entity';
import { Stop } from '../stops/entities/stop.entity';
import { Pod } from './entities/pod.entity';
import { LegacyAuthController } from './legacy-auth.controller';
import { LegacyAuthService } from './legacy-auth.service';
import { LegacyController } from './legacy.controller';
import { LegacyService } from './legacy.service';

@Module({
  imports: [TypeOrmModule.forFeature([Stop, Pod, Driver]), AttemptsModule],
  controllers: [LegacyController, LegacyAuthController],
  providers: [LegacyService, LegacyAuthService],
})
export class LegacyModule {}
