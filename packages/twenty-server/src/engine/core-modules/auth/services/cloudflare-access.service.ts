import { Injectable, Logger } from '@nestjs/common';

import { isNonEmptyString } from '@sniptt/guards';
import { type Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isPlainObject } from 'twenty-shared/utils';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

const CLOUDFLARE_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export type CloudflareAccessIdentity = {
  email: string;
  firstName?: string;
  lastName?: string;
};

@Injectable()
export class CloudflareAccessService {
  private readonly logger = new Logger(CloudflareAccessService.name);
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly twentyConfigService: TwentyConfigService) {}

  async verifyRequestOrThrow(
    request: Request,
  ): Promise<CloudflareAccessIdentity> {
    if (!this.twentyConfigService.get('CF_ACCESS_ENABLED')) {
      this.logger.warn('Cloudflare Access sign-in rejected: not enabled');
      throw this.forbidden('Cloudflare Access sign-in is not enabled');
    }

    const teamDomain = this.twentyConfigService.get('CF_ACCESS_TEAM_DOMAIN');
    const audience = this.twentyConfigService.get('CF_ACCESS_AUD');

    if (!teamDomain || !audience) {
      this.logger.warn(
        'Cloudflare Access sign-in rejected: team domain or AUD not configured',
      );
      throw this.forbidden('Cloudflare Access is not configured');
    }

    const token = request.headers?.[CLOUDFLARE_ACCESS_JWT_HEADER];

    if (typeof token !== 'string' || token.trim() === '') {
      this.logger.warn(
        'Cloudflare Access sign-in rejected: missing or blank token header',
      );
      throw this.forbidden('Missing Cloudflare Access token');
    }

    let email: unknown;
    let customClaims: unknown;

    try {
      this.jwks ??= createRemoteJWKSet(
        new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
      );

      const { payload } = await jwtVerify(token.trim(), this.jwks, {
        issuer: `https://${teamDomain}`,
        audience,
        clockTolerance: 30,
      });

      email = payload.email;
      customClaims = payload.custom;
    } catch (error) {
      this.logger.warn(
        `Cloudflare Access sign-in rejected: token verification failed (${
          error instanceof Error ? error.constructor.name : 'UnknownError'
        }: ${error instanceof Error ? error.message : 'unknown'})`,
      );
      throw this.forbidden('Invalid Cloudflare Access token');
    }

    if (typeof email !== 'string' || email.trim() === '') {
      this.logger.warn(
        'Cloudflare Access sign-in rejected: token has no email',
      );
      throw this.forbidden('Cloudflare Access token has no email');
    }

    const { given_name: givenName, family_name: familyName } = isPlainObject(
      customClaims,
    )
      ? customClaims
      : {};

    return {
      email: email.trim().toLowerCase(),
      firstName: isNonEmptyString(givenName) ? givenName.trim() : undefined,
      lastName: isNonEmptyString(familyName) ? familyName.trim() : undefined,
    };
  }

  private forbidden(message: string) {
    return new AuthException(message, AuthExceptionCode.FORBIDDEN_EXCEPTION);
  }
}
