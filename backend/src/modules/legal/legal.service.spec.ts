import { BadRequestException, NotFoundException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import type { DataSource } from 'typeorm';
import { LegalService, SubjectType } from './legal.service';

/**
 * The erasure boundary, which is the whole point of the routine.
 *
 * Two obligations pull in opposite directions here and both have to hold at
 * once. A person can require their personal data to be erased. A proof of
 * delivery cannot be erased while it is still needed to establish or defend a
 * legal claim, which UK GDPR Article 17(3)(e) exempts. Getting this wrong in
 * either direction is serious: too little and the erasure is not honoured, too
 * much and evidence is destroyed that a court may later ask for.
 *
 * So these tests assert what was cleared AND what was refused. The refusal
 * half is the one worth having: a change that quietly widened the redaction to
 * cover delivery_attempts would still pass a test that only checked contacts
 * were gone.
 */
describe('erasure (contacts go, evidence stays, and it is all recorded)', () => {
  const ACTOR = 'c3e3f8b4-2f73-4b5b-9c5c-6d9a2c4d3e03';
  const DRIVER = 'a1c1d6f2-0d51-4f39-9a3a-4b7f0a2b1c01';

  function build(opts: { subjectExists?: boolean } = {}) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];

    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('FOR UPDATE')) {
        return opts.subjectExists === false ? [] : [{ id: DRIVER }];
      }
      if (sql.includes('UPDATE refresh_tokens')) return [{ id: 'tok-1' }, { id: 'tok-2' }];
      if (sql.includes('count(*)') && sql.includes('delivery_attempts')) return [{ n: 41 }];
      return [];
    });

    const dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) => fn({ query })),
    } as unknown as DataSource;

    return { service: new LegalService(dataSource), queries };
  }

  const sqlText = (queries: Array<{ sql: string }>) => queries.map((q) => q.sql).join('\n');

  it('clears the driver contact fields and reports which ones', async () => {
    const { service, queries } = build();

    const result = await service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    expect(result.fieldsRedacted).toEqual(['email', 'display_name', 'password_hash']);
    const update = queries.find((q) => q.sql.includes('UPDATE drivers'));
    expect(update?.sql).toContain('email = $2');
    expect(update?.sql).toContain('display_name = $3');
    // Null wherever the schema allows it. display_name is NOT NULL on both
    // tables, so it gets a marker that says plainly what happened instead of
    // looking like data that was never collected.
    expect(update?.params).toEqual([DRIVER, null, '[erased]']);
  });

  it('overwrites the credential, so an erased subject cannot simply sign back in', async () => {
    const { service, queries } = build();

    await service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    // Revoking refresh tokens only closes the sessions that exist. Without
    // this, an erased driver signs in again seconds later with the password
    // they still know and mints a fresh family, and "erased" degrades to
    // "logged out". There is no other deactivation path in the API.
    const credential = queries.find(
      (q) => q.sql.includes('UPDATE drivers') && q.sql.includes('password_hash'),
    );
    expect(credential).toBeDefined();
    expect(credential?.params[0]).toBe(DRIVER);

    const written = credential?.params[1] as string;
    // A well-formed bcrypt hash, not a sentinel: the column is NOT NULL and
    // every read path expects to be able to compare against it. A malformed
    // value would leave us depending on the comparison library returning false
    // rather than throwing.
    expect(written).toMatch(/^\$2[aby]\$/);
    // And it matches nothing. Not the seeded password, not the marker itself.
    await expect(compare('TestDriver#2026', written)).resolves.toBe(false);
    await expect(compare('[erased]', written)).resolves.toBe(false);
    await expect(compare('', written)).resolves.toBe(false);
  });

  it('writes a different credential every time, so one erasure cannot unlock another', async () => {
    const first = build();
    const second = build();

    await first.service.erase(ACTOR, SubjectType.Driver, DRIVER, true);
    await second.service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    // A fixed replacement hash would be a master key across every erased
    // account the moment anyone learned its plaintext.
    const hashOf = (queries: Array<{ sql: string; params: unknown[] }>) =>
      queries.find((q) => q.sql.includes('UPDATE drivers') && q.sql.includes('password_hash'))
        ?.params[1];

    expect(hashOf(first.queries)).not.toBe(hashOf(second.queries));
  });

  it('revokes every refresh token the subject holds', async () => {
    const { service, queries } = build();

    const result = await service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    expect(result.tokensRevoked).toBe(2);
    const revoke = queries.find((q) => q.sql.includes('UPDATE refresh_tokens'));
    expect(revoke?.sql).toContain('driver_id = $1');
    expect(revoke?.params).toEqual([DRIVER, 'revoked']);
  });

  it('never writes to delivery_attempts or attempt_photos', async () => {
    const { service, queries } = build();

    await service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    // The evidence tables may be READ (we report how much was retained) but
    // must never appear in a statement that changes them.
    const mutations = queries
      .map((q) => q.sql)
      .filter((sql) => /\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i.test(sql));
    for (const sql of mutations) {
      expect(sql).not.toMatch(/delivery_attempts/i);
      expect(sql).not.toMatch(/attempt_photos/i);
    }
    expect(sqlText(queries)).toMatch(/count\(\*\)[\s\S]*delivery_attempts/);
  });

  it('reports how much evidence was deliberately retained', async () => {
    const { service } = build();

    const result = await service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    // Answering "we erased you but kept 41 delivery records, and here is why"
    // is the honest response to an erasure request, not a footnote.
    expect(result.evidenceRetained).toBe(41);
  });

  it('writes an audit row naming the actor, the subject and the fields', async () => {
    const { service, queries } = build();

    await service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    const log = queries.find((q) => q.sql.includes('INSERT INTO erasure_log'));
    expect(log).toBeDefined();
    expect(log?.params[0]).toBe(ACTOR);
    expect(log?.params[1]).toBe(SubjectType.Driver);
    expect(log?.params[2]).toBe(DRIVER);
    expect(JSON.parse(log?.params[3] as string)).toEqual(['email', 'display_name', 'password_hash']);
  });

  it('records field names only, never the values it erased', async () => {
    const { service, queries } = build();

    await service.erase(ACTOR, SubjectType.Driver, DRIVER, true);

    // A log quoting the old address would reinstate the personal data the
    // erasure was carried out to remove.
    const log = queries.find((q) => q.sql.includes('INSERT INTO erasure_log'));
    expect(JSON.stringify(log?.params)).not.toMatch(/@/);
  });

  it('refuses without an explicit confirmation', async () => {
    const { service, queries } = build();

    await expect(service.erase(ACTOR, SubjectType.Driver, DRIVER, false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(queries).toHaveLength(0);
  });

  it('refuses for a subject that does not exist', async () => {
    const { service } = build({ subjectExists: false });

    await expect(service.erase(ACTOR, SubjectType.Driver, DRIVER, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('erases an office user from their own table', async () => {
    const { service, queries } = build();

    await service.erase(ACTOR, SubjectType.OfficeUser, DRIVER, true);

    expect(queries.some((q) => q.sql.includes('UPDATE office_users'))).toBe(true);
    expect(queries.find((q) => q.sql.includes('UPDATE refresh_tokens'))?.sql).toContain(
      'office_user_id = $1',
    );

    // office_users.email is NOT NULL and UNIQUE, so it cannot be nulled and
    // cannot collide with the next erasure. .invalid is reserved by RFC 2606,
    // so an erased address can never be mistaken for a live one or mailed.
    const update = queries.find((q) => q.sql.includes('UPDATE office_users'));
    expect(update?.params[1]).toBe(`erased-${DRIVER}@erased.invalid`);
    expect(update?.params[2]).toBe('[erased]');
  });
});
