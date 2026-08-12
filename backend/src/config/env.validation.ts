import * as Joi from 'joi';

/**
 * Boot fails fast on a bad environment - a misconfigured evidence system
 * must refuse to start, not limp.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().default(3000),
  INSTANCE_ID: Joi.string().default('backend-local'),

  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),

  JWT_SECRET: Joi.string().min(32).required(),
  // The unit here is a driver's working week, not a browser session: the
  // handset spends days out of signal and a sign-in prompt at a doorstep costs
  // a delivery. DECISIONS.md records the revocation trade-off this accepts.
  JWT_ACCESS_TTL_SEC: Joi.number().integer().default(604800), // 7 days
  REFRESH_TTL_DAYS: Joi.number().integer().default(90),

  AWS_REGION: Joi.string().default('ap-southeast-1'),
  S3_BUCKET: Joi.string().required(),
  // Local dev talks to localstack; prod uses the instance role (no keys anywhere).
  S3_ENDPOINT: Joi.string().uri().optional(),

  BEDROCK_MODEL_ID: Joi.string().default('global.anthropic.claude-haiku-4-5-20251001-v1:0'),
  AI_TIMEOUT_MS: Joi.number().integer().default(3000),
  AI_ENABLED: Joi.boolean().default(true),

  DUAL_WRITE_PODS: Joi.boolean().default(true),

  MIN_APP_VERSION: Joi.string().default('1.0.0'),
  LATEST_APP_VERSION: Joi.string().default('2.0.0'),
  BLOCKED_APP_VERSIONS: Joi.string().allow('').default(''),
  APK_DOWNLOAD_URL: Joi.string().uri().optional(),

  PRESIGN_PUT_TTL_SEC: Joi.number().integer().default(900),
  PRESIGN_GET_TTL_SEC: Joi.number().integer().default(300),
});
