import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { jwtConstants } from './constants.js';
import {
  AccessTokenValidator,
  type AccessPayload,
} from './access-token.validator.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly validator: AccessTokenValidator) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConstants.accessSecret,
    });
  }

  /**
   * Signature/expiry are already verified by Passport (secretOrKey). Delegate the revocation-aware
   * checks (jti blacklist + tokenVersion) to AccessTokenValidator so the API and /uploads/* media
   * surfaces enforce identical rules. Returning null → Passport throws 401.
   */
  async validate(payload: AccessPayload) {
    return this.validator.validatePayload(payload);
  }
}
