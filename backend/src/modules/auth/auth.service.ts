import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { compare } from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { Audience } from '../../common/auth/jwt-payload';
import type { JwtPayload, Role } from '../../common/auth/jwt-payload';
import { Device } from '../drivers/entities/device.entity';
import { Driver } from '../drivers/entities/driver.entity';
import { OfficeUser } from '../office/entities/office-user.entity';
import { RefreshToken, RefreshTokenStatus } from './entities/refresh-token.entity';

/**
 * Replay of a rotated refresh token within this window is treated as a lost
 * response (client never received its successor), not as theft.
 */
const ROTATION_GRACE_MS = 60_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSec: number;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(OfficeUser) private readonly officeUsers: Repository<OfficeUser>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async driverLogin(
    employeeRef: string,
    password: string,
    deviceFingerprint: string,
    appVersion: string | undefined,
  ): Promise<TokenPair & { driver: { id: string; displayName: string; employeeRef: string } }> {
    const driver = await this.drivers.findOne({ where: { employeeRef, isActive: true } });
    if (!driver || !(await compare(password, driver.passwordHash))) {
      // Same error for unknown ref and bad password - no account enumeration.
      throw new UnauthorizedException('Invalid credentials');
    }

    const device = await this.upsertDevice(deviceFingerprint, appVersion);
    const pair = await this.issueTokens({ sub: driver.id, role: 'driver', deviceId: device.id });
    return {
      ...pair,
      driver: { id: driver.id, displayName: driver.displayName, employeeRef: driver.employeeRef },
    };
  }

  async officeLogin(
    email: string,
    password: string,
  ): Promise<TokenPair & { user: { id: string; displayName: string; email: string } }> {
    const user = await this.officeUsers.findOne({ where: { email: email.toLowerCase() } });
    if (!user || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const pair = await this.issueTokens({ sub: user.id, role: 'office' });
    return { ...pair, user: { id: user.id, displayName: user.displayName, email: user.email } };
  }

  /**
   * Rotation with lost-response recovery:
   * - active token   -> rotate: mark rotated, mint successor, return it
   * - rotated token within grace -> revoke the unclaimed successor, mint a
   *   fresh one (we only store hashes, so the original successor cannot be
   *   re-served), return it
   * - rotated token after grace / revoked -> revoke the whole family
   */
  async refresh(refreshTokenPlain: string): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshTokenPlain);
    const stored = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!stored) throw new UnauthorizedException('Unknown refresh token');

    const now = Date.now();
    if (stored.expiresAt.getTime() < now) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (stored.status === RefreshTokenStatus.Revoked) {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Refresh token revoked');
    }

    if (stored.status === RefreshTokenStatus.Rotated) {
      const withinGrace =
        stored.rotatedAt !== null && now - stored.rotatedAt.getTime() <= ROTATION_GRACE_MS;
      if (!withinGrace) {
        // Reuse long after rotation = theft signal. Contain the family.
        await this.revokeFamily(stored.familyId);
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      if (!stored.successorId) {
        // Rotation is still in flight on another request/instance: its
        // successor is not linked yet. Retrying is safe; guessing is not.
        throw new ConflictException('Refresh in progress, retry');
      }
      // Revoking the unclaimed successor IS the arbiter here: whoever wins
      // this conditioned UPDATE is the single caller allowed to re-rotate,
      // so two late replays cannot both mint a successor.
      const revoked = await this.refreshTokens.update(
        { id: stored.successorId, status: RefreshTokenStatus.Active },
        { status: RefreshTokenStatus.Revoked },
      );
      if (revoked.affected !== 1) throw new ConflictException('Refresh in progress, retry');
      return this.rotate(stored);
    }

    // Active: claim it atomically so two racing refreshes can't both rotate.
    const claimed = await this.refreshTokens.update(
      { id: stored.id, status: RefreshTokenStatus.Active },
      { status: RefreshTokenStatus.Rotated, rotatedAt: new Date() },
    );
    if (claimed.affected !== 1) {
      // A concurrent duplicate of an in-flight refresh (aggressive client
      // retry, or two LB instances). The winner's successor is already on
      // its way to this same client, so we must NOT fall into the
      // lost-response path: that would revoke the live successor (logging
      // the driver out mid-shift) or mint a second parallel active token.
      throw new ConflictException('Refresh in progress, retry');
    }
    return this.rotate(stored);
  }

  private async rotate(predecessor: RefreshToken): Promise<TokenPair> {
    const payload: JwtPayload = predecessor.driverId
      ? { sub: predecessor.driverId, role: 'driver', deviceId: predecessor.deviceId ?? undefined }
      : { sub: predecessor.officeUserId as string, role: 'office' };

    const pair = await this.issueTokens(payload, predecessor.familyId);
    const successor = await this.refreshTokens.findOne({
      where: { tokenHash: this.hashToken(pair.refreshToken) },
    });
    await this.refreshTokens.update(
      { id: predecessor.id },
      { rotatedAt: predecessor.rotatedAt ?? new Date(), successorId: successor?.id ?? null },
    );
    return pair;
  }

  private async issueTokens(payload: JwtPayload, familyId?: string): Promise<TokenPair> {
    const accessTtlSec = this.config.get<number>('JWT_ACCESS_TTL_SEC', 900);
    const refreshTtlDays = this.config.get<number>('REFRESH_TTL_DAYS', 14);

    // Every token minted here says it is for v2. The frozen v1 surface issues
    // its own with the legacy audience and its own lifetime, so a change to
    // these numbers cannot reach a handset that cannot be updated.
    const accessToken = await this.jwtService.signAsync(
      { sub: payload.sub, role: payload.role, deviceId: payload.deviceId, aud: Audience.V2 },
      { expiresIn: accessTtlSec },
    );

    const refreshPlain = randomBytes(48).toString('base64url');
    await this.refreshTokens.insert({
      tokenHash: this.hashToken(refreshPlain),
      familyId: familyId ?? randomUUID(),
      driverId: payload.role === 'driver' ? payload.sub : null,
      officeUserId: payload.role === 'office' ? payload.sub : null,
      deviceId: payload.deviceId ?? null,
      status: RefreshTokenStatus.Active,
      expiresAt: new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000),
    });

    return { accessToken, refreshToken: refreshPlain, accessExpiresInSec: accessTtlSec };
  }

  private async upsertDevice(fingerprint: string, appVersion: string | undefined): Promise<Device> {
    const rows = (await this.devices.query(
      `INSERT INTO devices (device_fingerprint, platform, last_seen_app_version)
       VALUES ($1, 'android', $2)
       ON CONFLICT (device_fingerprint)
       DO UPDATE SET last_seen_app_version = EXCLUDED.last_seen_app_version, last_seen_at = now()
       RETURNING id`,
      [fingerprint, appVersion ?? null],
    )) as Array<{ id: string }>;
    return this.devices.findOneOrFail({ where: { id: rows[0].id } });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.refreshTokens.update({ familyId }, { status: RefreshTokenStatus.Revoked });
  }

  private hashToken(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }
}
