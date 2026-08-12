import { INestApplication, VersioningType } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PrivacyController } from './privacy.controller';

/**
 * The global JwtAuthGuard is mounted here on purpose. The one property this
 * page must never lose is that it answers an anonymous request: Google Play
 * re-checks the policy URL after launch and enforces against apps whose
 * policy stops resolving, so a 401 here is a store-listing outage, not a
 * bug someone notices in the logs.
 */
describe('PrivacyController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PrivacyController],
      providers: [
        Reflector,
        // Never called: the route is @Public(), which is the point.
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the policy to a request carrying no access token', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/privacy')
      .expect(200);

    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('<title>Privacy Policy');
  });

  it('names the app, the retention period and a contact address', async () => {
    const { text } = await request(app.getHttpServer()).get('/api/privacy');

    // Play cross-checks the policy against the Data safety declaration and
    // the package name on the listing; these are the three things a
    // reviewer looks for and the three most likely to rot.
    expect(text).toContain('com.podv2.driver');
    expect(text).toContain('buttawb@gmail.com');

    // The stated retention has to be the one the infrastructure enforces.
    // This assertion previously pinned "18 months", which the S3 lifecycle
    // rule has not agreed with since it was corrected to 2192 days: the page
    // was telling the public their evidence would be destroyed four and a half
    // years before it actually would be, and this test was holding that in
    // place. A retention period in a privacy policy is a promise, so the
    // number here and the number in terraform have to move together.
    expect(text).toContain('Six years');
    expect(text).not.toContain('18 months');
  });

  it('declares every data type the Data safety form declares', async () => {
    const { text } = await request(app.getHttpServer()).get('/api/privacy');

    for (const disclosure of [
      'Precise location',
      'Photographs',
      'Signature image',
      'Driver name and employee reference',
      'Delivery address and postcode',
      'device installation identifier',
    ]) {
      expect(text).toContain(disclosure);
    }
  });

  it('loads nothing external, so the page cannot break or leak by reference', async () => {
    const { text } = await request(app.getHttpServer()).get('/api/privacy');

    expect(text).not.toMatch(/<script/i);
    expect(text).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(text).not.toMatch(/<link[^>]+stylesheet/i);
  });
});
