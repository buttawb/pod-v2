import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/jwt-auth.guard';

/**
 * The version-policy endpoint the app polls (on foreground and every 15
 * minutes). Public: the version gate must work before login. Headers on
 * every API response (VersionHeadersInterceptor) cover mid-shift changes;
 * this endpoint carries the full policy document.
 */
@ApiTags('config')
@Controller({ path: 'config', version: VERSION_NEUTRAL })
export class AppConfigController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'App version policy (no auth required)',
    description: [
      'Press *Try it out* and *Execute*. There is no body, no parameter and no token needed,',
      'so this works before you sign in. Along with the two health endpoints it is the fastest',
      'way to confirm you are talking to a live instance.',
      '',
      'This is the document the handset polls on foreground and then every 15 minutes to find',
      'out whether it is still allowed to run. `minAppVersion` is the floor, `latestAppVersion`',
      'is what an up-to-date handset should be on, and `blockedVersions` is an exact-match kill',
      'list for builds pulled mid-shift. `updateUrl` is where the APK lives, or null when no',
      'build has been published for this environment.',
      '',
      'The `policy` block is what the app does about a version that is too old: it gets a',
      '12 hour grace window, may still capture during it (`blockNewCapturesInGrace` is false),',
      'and uploading already-captured evidence is never blocked. Evidence that exists on a',
      'handset must always be able to reach the server, even from a build we are retiring,',
      'because the alternative is stranding proof of a delivery that really happened.',
      '',
      'Note that this endpoint is not the only channel. Every API response also carries',
      '`X-Min-App-Version`, `X-Latest-App-Version` and `X-Kill-Switch`, so a policy change',
      'lands on the next sync rather than at the next poll. `X-Kill-Switch` is per request: it',
      'is 1 only when the caller sent an `X-App-Version` header that is on the block list.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description:
      'The current policy document. Values come from environment configuration.',
    schema: {
      example: {
        minAppVersion: '1.0.0',
        latestAppVersion: '2.0.0',
        blockedVersions: [],
        updateUrl: null,
        policy: {
          graceHours: 12,
          blockNewCapturesInGrace: false,
          uploadAlwaysAllowed: true,
        },
      },
    },
  })
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
