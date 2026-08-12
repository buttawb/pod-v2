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
