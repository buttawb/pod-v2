import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepotController, StopsController } from './stops.controller';
import { Stop } from './entities/stop.entity';
import { StopsService } from './stops.service';

@Module({
  imports: [TypeOrmModule.forFeature([Stop])],
  controllers: [StopsController, DepotController],
  providers: [StopsService],
  exports: [StopsService],
})
export class StopsModule {}
