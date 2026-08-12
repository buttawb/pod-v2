export const Role = {
  Driver: 'driver',
  Office: 'office',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/**
 * Which app surface a token was minted for.
 *
 * v1.4.2 and v2 are different products on different release cadences: the
 * backend ships in an afternoon, the app waits weeks on store review. Sharing
 * one token contract between them means any change to v2's auth (a shorter
 * lifetime, a new claim, a rotated secret) lands on the 30% of the fleet that
 * cannot be updated. Stamping the surface into the token lets the two evolve
 * independently, and stops a token minted for one being replayed at the other.
 */
export const Audience = {
  Legacy: 'pod-v1',
  V2: 'pod-v2',
} as const;

export type Audience = (typeof Audience)[keyof typeof Audience];

export interface JwtPayload {
  /** driver_id or office_user_id */
  sub: string;
  role: Role;
  deviceId?: string;
  /**
   * Absent on tokens minted before this claim existed, which are treated as v2
   * so live sessions survive the deploy. The legacy surface never accepts an
   * absent audience, so separation holds in the direction that matters.
   */
  aud?: Audience;
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}
