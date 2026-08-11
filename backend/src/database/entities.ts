import { AiSummary } from '../modules/ai/entities/ai-summary.entity';
import { AiSummaryCache } from '../modules/ai/entities/ai-summary-cache.entity';
import { AttemptPhoto } from '../modules/attempts/entities/attempt-photo.entity';
import { DeliveryAttempt } from '../modules/attempts/entities/delivery-attempt.entity';
import { Device } from '../modules/drivers/entities/device.entity';
import { Driver } from '../modules/drivers/entities/driver.entity';
import { OfficeUser } from '../modules/office/entities/office-user.entity';
import { Pod } from '../modules/legacy/entities/pod.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';
import { Stop } from '../modules/stops/entities/stop.entity';

export const ALL_ENTITIES = [
  AiSummary,
  AiSummaryCache,
  AttemptPhoto,
  DeliveryAttempt,
  Device,
  Driver,
  OfficeUser,
  Pod,
  RefreshToken,
  Stop,
];
