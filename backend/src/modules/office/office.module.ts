import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { EventsBusService } from './events-bus.service';
import { OfficeUser } from './entities/office-user.entity';
import { ConflictsController } from './conflicts.controller';
import { OfficeController } from './office.controller';
import { OfficeService } from './office.service';

@Module({
  imports: [TypeOrmModule.forFeature([OfficeUser]), AiModule],
  controllers: [OfficeController, ConflictsController],
  providers: [OfficeService, EventsBusService],
})
export class OfficeModule {}
