import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/auth/jwt-auth.guard';

/**
 * The version-policy endpoint the app polls (on foreground and every 15
 * minutes). Public: the version gate must work before login. Headers on
 * every API response (VersionHeadersInterceptor) cover mid-shift changes;
 * this endpoint carries the full policy document.
 */
@Controller({ path: 'config', version: VERSION_NEUTRAL })
export class AppConfigController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  policy() {
    return {
      minAppVersion: this.config.get<string>('MIN_APP_VERSION', '1.0.0'),
      latestAppVersion: this.config.get<string>('LATEST_APP_VERSION', '2.0.0'),
      blockedVersions: this.blockedVersions(),
      updateUrl: this.config.get<string>('APK_DOWNLOAD_URL') ?? null,
      policy: {
        graceHours: 12,
        blockNewCapturesInGrace: false,
        uploadAlwaysAllowed: true,
      },
    };
  }

  private blockedVersions(): string[] {
    return (this.config.get<string>('BLOCKED_APP_VERSIONS', '') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
}
