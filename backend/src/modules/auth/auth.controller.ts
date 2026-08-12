import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/jwt-auth.guard';
import { AuthService } from './auth.service';
import { DriverLoginDto, OfficeLoginDto, RefreshDto } from './dto/auth.dtos';

@ApiTags('auth')
@Controller({ path: 'auth', version: '2' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('driver/login')
  driverLogin(@Body() dto: DriverLoginDto) {
    return this.authService.driverLogin(
      dto.employeeRef,
      dto.password,
      dto.deviceFingerprint,
      dto.appVersion,
    );
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('office/login')
  officeLogin(@Body() dto: OfficeLoginDto) {
    return this.authService.officeLogin(dto.email, dto.password);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }
}
