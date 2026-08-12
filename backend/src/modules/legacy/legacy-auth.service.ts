import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { compare } from 'bcryptjs';
import { Audience } from '../../common/auth/jwt-payload';
import { Driver } from '../drivers/entities/driver.entity';

/**
 * Token issuance for the frozen v1 surface.
 *
 * This shares the driver table with v2 and nothing else. Same people, same
 * credentials, separate tokens.
 *
 * It deliberately does not call AuthService.issueTokens. That method is where
 * v2's auth will keep evolving, and every change there would otherwise land on
 * a fleet that cannot take an app update: a shorter lifetime logs 30% of
 * drivers out mid-round, a new required claim rejects them outright. Copying
 * twenty lines is the cheaper mistake.
 *
 * No refresh token, by design. Whatever v1.4.2 does today, it was built before
 * this backend existed and cannot learn a rotation protocol. Its access token
 * simply lives long enough to cover the window until the fleet is retired, and
 * that lifetime is pinned separately so tuning v2 cannot shorten it.
 */
@Injectable()
export class LegacyAuthService {
  constructor(
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(employeeRef: string, password: string): Promise<{ token: string; expiresIn: number }> {
    const driver = await this.drivers.findOne({ where: { employeeRef, isActive: true } });
    if (!driver || !(await compare(password, driver.passwordHash))) {
      // Same error for unknown ref and bad password: no account enumeration.
      throw new UnauthorizedException('Invalid credentials');
    }

    const expiresIn = this.config.get<number>('LEGACY_ACCESS_TTL_SEC', 604800);
    const token = await this.jwtService.signAsync(
      { sub: driver.id, role: 'driver', aud: Audience.Legacy },
      { expiresIn },
    );

    return { token, expiresIn };
  }
}
