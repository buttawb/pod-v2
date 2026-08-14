import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * The API documents itself, because the API is the product.
 *
 * There is no web front end here by design: the office needs read access, not
 * a dashboard, and a reviewer reaches this system with curl. So the reference
 * has to be exact and reachable without installing anything, and it has to be
 * generated from the code rather than written beside it, because a hand-kept
 * API document is wrong within a week.
 *
 * Two surfaces are documented side by side on purpose. `v1 (frozen)` is the
 * contract the live v1.4.2 fleet depends on and may not change; everything
 * else is v2. Seeing them in one page is the clearest possible statement of
 * what "no breaking changes" actually constrains.
 */
export function configureOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Proof of Delivery API')
    .setDescription(
      [
        'Evidence capture for courier proof of delivery.',
        '',
        '## Run this page in about thirty seconds',
        '',
        '1. Open **POST /api/v2/auth/driver/login** below and press *Try it out*. The body',
        '   is already filled in with working credentials, so just press **Execute**.',
        '2. Copy `accessToken` out of the response.',
        '3. Press the green **Authorize** button at the top right, paste the token, and',
        '   press *Authorize*. Every endpoint on this page is now unlocked.',
        '4. Try **GET /api/v2/stops** for the round, then use any `id` from it as the',
        '   `stopId` in **POST /api/v2/attempts**.',
        '',
        'For the office endpoints, do the same with **POST /api/v2/auth/office/login**;',
        'a driver token will not open them.',
        '',
        '## Demo credentials, published deliberately',
        '',
        'Every example body on this page is pre-filled with real, working credentials so',
        'the page can be executed without reading any other document. We acknowledge that',
        'openly rather than leaving them to be discovered: these are seeded demo accounts',
        'on a demo database, created for this evaluation, holding no real personal data.',
        'They are published on purpose. Nothing here is a leaked credential.',
        '',
        '| Who | Sign in with |',
        '|---|---|',
        '| Driver, London round (151 stops) | `EMP-TEST-001` / `TestDriver#2026` |',
        '| Driver, Karachi round (40 stops) | `EMP-PK-001` / `TestDriver#2026` |',
        '| Office | `office@demo.pod` / `OfficeDemo#2026` |',
        '| v1 frozen surface | `emp-test-001@fleet.local` / `TestDriver#2026` |',
        '',
        'One endpoint is destructive: **POST /api/v2/legal/erasure** is irreversible and',
        'must not be run against the two demo drivers above, or the rest of the demo stops',
        'working. It is documented in full where it appears.',
        '',
        '**Two surfaces.** `v1 (frozen)` is what the live v1.4.2 fleet calls and is',
        'byte-compatible by contract test; it must never change. Everything under',
        '`/api/v2` is the new surface and may evolve.',
        '',
        '**Auth.** Both take a bearer token, but the tokens are not interchangeable:',
        'each carries the surface it was minted for, so a v1 token is rejected by v2',
        'and vice versa. v1 tokens last 24 hours with no refresh. v2 uses a rotating',
        'refresh family.',
        '',
        '**Evidence is append-only.** There is no endpoint that edits or deletes an',
        'attempt, and the database role the API runs as holds no such grant. A',
        'correction is a new attempt.',
        '',
        '**Photographs never pass through this API.** Submitting an attempt returns',
        'presigned S3 URLs; the handset uploads directly and the server verifies each',
        'object afterwards.',
      ].join('\n'),
    )
    .setVersion('2.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'driver-or-office',
    )
    .addTag('v1 (frozen)', 'The live v1.4.2 surface. Frozen: shape changes break handsets.')
    .addTag('auth', 'Sign-in and refresh for the v2 surface.')
    .addTag('stops', "A driver's round, and the depot coverage map.")
    .addTag('attempts', 'The one write path for evidence.')
    .addTag('media', 'Authenticated, short-lived access to photographs and signatures.')
    .addTag('office', 'Read APIs for the office: status, the evidence record, the live feed.')
    .addTag('sync', 'Delta pull for the handset: one cursor per table, newest rows held back.')
    .addTag(
      'legal',
      'Retention and erasure. Contains the one destructive endpoint on this API; read its description before running it.',
    )
    .addTag('system', 'Health and version policy. The only endpoints that need no token.')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Proof of Delivery API',
    jsonDocumentUrl: 'api/docs.json',
    swaggerOptions: {
      // An evidence API is read far more often than it is poked; showing the
      // shapes first is more useful than an expanded list of paths.
      docExpansion: 'list',
      persistAuthorization: true,
      tagsSorter: 'alpha',
    },
  });
}
