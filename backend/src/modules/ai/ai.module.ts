import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiSummaryService } from './ai-summary.service';
import { AiSummary } from './entities/ai-summary.entity';
import { AiSummaryCache } from './entities/ai-summary-cache.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AiSummary, AiSummaryCache])],
  providers: [AiSummaryService],
  exports: [AiSummaryService],
})
export class AiModule {}
