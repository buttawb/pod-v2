import { Module } from '@nestjs/common';
import { ErasureController } from './erasure.controller';
import { LegalService } from './legal.service';
import { PrivacyController } from './privacy.controller';

/**
 * The privacy page and the erasure route belong together: one states what we
 * do with personal data, the other is the thing that carries it out. Keeping
 * them apart is how the page came to promise a retention window the
 * infrastructure did not enforce.
 */
@Module({
  controllers: [PrivacyController, ErasureController],
  providers: [LegalService],
})
export class LegalModule {}
