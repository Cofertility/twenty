import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { type Request } from 'express';
import * as jose from 'jose';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { CloudflareAccessService } from 'src/engine/core-modules/auth/services/cloudflare-access.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

jest.mock('jose', () => ({
  ...jest.requireActual('jose'),
  createRemoteJWKSet: jest.fn(),
}));

const ISSUER = 'https://team.cloudflareaccess.com';

describe('CloudflareAccessService', () => {
  let privateKey: jose.KeyLike;
  let otherPrivateKey: jose.KeyLike;
  let publicJwk: jose.JWK;
  const kid = 'test-kid';
  let config: Record<string, unknown>;

  const enabledConfig = {
    CF_ACCESS_ENABLED: true,
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'aud-tag',
  };

  const createService = async () => {
    const module = await Test.createTestingModule({
      providers: [
        CloudflareAccessService,
        {
          provide: TwentyConfigService,
          useValue: { get: jest.fn((key: string) => config[key]) },
        },
      ],
    }).compile();

    return module.get(CloudflareAccessService);
  };

  const sign = ({
    claims = { email: 'jane@cofertility.com' },
    issuer = ISSUER,
    audience = 'aud-tag',
    expiration = '5m' as string | number,
    key = privateKey,
    issuedAtOffsetSeconds = 0,
  }: {
    claims?: Record<string, unknown>;
    issuer?: string;
    audience?: string;
    expiration?: string | number;
    key?: jose.KeyLike;
    issuedAtOffsetSeconds?: number;
  } = {}) =>
    new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt(Math.floor(Date.now() / 1000) + issuedAtOffsetSeconds)
      .setNotBefore(Math.floor(Date.now() / 1000) + issuedAtOffsetSeconds)
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(expiration)
      .sign(key);

  const requestWith = (token?: string) =>
    ({
      headers: token === undefined ? {} : { 'cf-access-jwt-assertion': token },
    }) as unknown as Request;

  const expectForbidden = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e) => e,
    );

    expect(error).toBeInstanceOf(AuthException);
    expect(error.code).toBe(AuthExceptionCode.FORBIDDEN_EXCEPTION);
  };

  beforeAll(async () => {
    const pair = await jose.generateKeyPair('RS256');

    privateKey = pair.privateKey;
    otherPrivateKey = (await jose.generateKeyPair('RS256')).privateKey;
    publicJwk = {
      ...(await jose.exportJWK(pair.publicKey)),
      kid,
      alg: 'RS256',
    };
  });

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    config = { ...enabledConfig };
    (jose.createRemoteJWKSet as jest.Mock)
      .mockReset()
      .mockImplementation(() => jose.createLocalJWKSet({ keys: [publicJwk] }));
  });

  it('returns the email for a valid token', async () => {
    const service = await createService();

    await expect(
      service.verifyRequestOrThrow(requestWith(await sign())),
    ).resolves.toEqual({ email: 'jane@cofertility.com' });
  });

  it('lowercases the email claim', async () => {
    const service = await createService();
    const token = await sign({ claims: { email: 'Jane@Cofertility.com' } });

    await expect(
      service.verifyRequestOrThrow(requestWith(token)),
    ).resolves.toEqual({ email: 'jane@cofertility.com' });
  });

  it('returns the names from the custom claims', async () => {
    const service = await createService();
    const token = await sign({
      claims: {
        email: 'jane@cofertility.com',
        custom: { given_name: ' Jane ', family_name: 'Doe' },
      },
    });

    await expect(
      service.verifyRequestOrThrow(requestWith(token)),
    ).resolves.toStrictEqual({
      email: 'jane@cofertility.com',
      firstName: 'Jane',
      lastName: 'Doe',
    });
  });

  it('omits names when custom claims are missing or not strings', async () => {
    const service = await createService();
    const token = await sign({
      claims: {
        email: 'jane@cofertility.com',
        custom: { given_name: '', family_name: 42 },
      },
    });

    await expect(
      service.verifyRequestOrThrow(requestWith(token)),
    ).resolves.toStrictEqual({
      email: 'jane@cofertility.com',
      firstName: undefined,
      lastName: undefined,
    });
  });

  it('builds the key set from the team domain', async () => {
    const service = await createService();

    await service.verifyRequestOrThrow(requestWith(await sign()));

    expect(jose.createRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://team.cloudflareaccess.com/cdn-cgi/access/certs'),
    );
  });

  it('rejects a token signed by another key', async () => {
    const service = await createService();
    const token = await sign({ key: otherPrivateKey });

    await expectForbidden(service.verifyRequestOrThrow(requestWith(token)));
  });

  it('rejects the wrong audience', async () => {
    const service = await createService();
    const token = await sign({ audience: 'other' });

    await expectForbidden(service.verifyRequestOrThrow(requestWith(token)));
  });

  it('rejects the wrong issuer', async () => {
    const service = await createService();
    const token = await sign({ issuer: 'https://evil.cloudflareaccess.com' });

    await expectForbidden(service.verifyRequestOrThrow(requestWith(token)));
  });

  it('rejects an expired token', async () => {
    const service = await createService();
    const token = await sign({
      expiration: Math.floor(Date.now() / 1000) - 60,
    });

    await expectForbidden(service.verifyRequestOrThrow(requestWith(token)));
  });

  it('rejects a token without an email claim', async () => {
    const service = await createService();
    const token = await sign({ claims: { common_name: 'x' } });

    await expectForbidden(service.verifyRequestOrThrow(requestWith(token)));
  });

  it('rejects a missing or blank header', async () => {
    const service = await createService();

    await expectForbidden(service.verifyRequestOrThrow(requestWith()));
    await expectForbidden(service.verifyRequestOrThrow(requestWith('')));
  });

  it('throws when disabled', async () => {
    config = { ...enabledConfig, CF_ACCESS_ENABLED: false };
    const service = await createService();

    await expectForbidden(
      service.verifyRequestOrThrow(requestWith(await sign())),
    );
    expect(jose.createRemoteJWKSet).not.toHaveBeenCalled();
  });

  it('does not build a key set when disabled', async () => {
    config = { CF_ACCESS_ENABLED: false, CF_ACCESS_TEAM_DOMAIN: undefined };

    await expect(createService()).resolves.toBeDefined();
    expect(jose.createRemoteJWKSet).not.toHaveBeenCalled();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('accepts a token whose nbf/iat is slightly in the future', async () => {
    const service = await createService();
    const token = await sign({ issuedAtOffsetSeconds: 20 });

    await expect(
      service.verifyRequestOrThrow(requestWith(token)),
    ).resolves.toEqual({ email: 'jane@cofertility.com' });
  });

  it('rejects a token whose nbf is far in the future', async () => {
    const service = await createService();
    const token = await sign({ issuedAtOffsetSeconds: 120 });

    await expectForbidden(service.verifyRequestOrThrow(requestWith(token)));
  });

  it('logs a warning without the token when verification fails', async () => {
    const service = await createService();
    const token = await sign({ key: otherPrivateKey });

    await expectForbidden(service.verifyRequestOrThrow(requestWith(token)));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('token verification failed');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(token);
  });

  it('logs a warning for a blank header', async () => {
    const service = await createService();

    await expectForbidden(service.verifyRequestOrThrow(requestWith('')));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
