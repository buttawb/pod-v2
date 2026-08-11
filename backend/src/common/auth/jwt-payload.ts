export const Role = {
  Driver: 'driver',
  Office: 'office',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export interface JwtPayload {
  /** driver_id or office_user_id */
  sub: string;
  role: Role;
  deviceId?: string;
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}
