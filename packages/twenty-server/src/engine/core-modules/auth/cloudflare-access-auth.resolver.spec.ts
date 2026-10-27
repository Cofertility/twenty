import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { type Request } from 'express';

import { AuthException } from 'src/engine/core-modules/auth/auth.exception';
import { CloudflareAccessAuthResolver } from 'src/engine/core-modules/auth/cloudflare-access-auth.resolver';
import { AuthService } from 'src/engine/core-modules/auth/services/auth.service';
import { CloudflareAccessService } from 'src/engine/core-modules/auth/services/cloudflare-access.service';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { UserSessionService } from 'src/engine/core-modules/user-session/services/user-session.service';
import { UserService } from 'src/engine/core-modules/user/services/user.service';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';

describe('CloudflareAccessAuthResolver', () => {
  const email = 'jane@cofertility.com';
  const workspace = { id: 'ws-1' };
  const tokens = { tokens: { accessOrWorkspaceAgnosticToken: { token: 't' } } };
  const req = { headers: {} } as unknown as Request;

  let resolver: CloudflareAccessAuthResolver;
  const cloudflareAccessService = { verifyRequestOrThrow: jest.fn() };
  const authService = {
    findWorkspaceForSignInUp: jest.fn(),
    findInvitationForSignInUp: jest.fn(),
    formatUserDataPayload: jest.fn(),
    checkAccessForSignIn: jest.fn(),
    signInUp: jest.fn(),
    verify: jest.fn(),
  };
  const userService = {
    findUserByEmail: jest.fn(),
    markEmailAsVerified: jest.fn(),
  };
  const workspaceDomainsService = {
    getWorkspaceByOriginOrDefaultWorkspace: jest.fn(),
  };
  const userSessionService = { issueSessionForTokenPair: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();

    cloudflareAccessService.verifyRequestOrThrow.mockResolvedValue({ email });
    workspaceDomainsService.getWorkspaceByOriginOrDefaultWorkspace.mockResolvedValue(
      workspace,
    );
    authService.findWorkspaceForSignInUp.mockResolvedValue(workspace);
    authService.findInvitationForSignInUp.mockResolvedValue(undefined);
    authService.formatUserDataPayload.mockImplementation(
      (newUserPayload: unknown, existingUser: unknown) => ({
        userData: existingUser
          ? { type: 'existingUser', existingUser }
          : { type: 'newUser', newUserPayload },
      }),
    );
    authService.checkAccessForSignIn.mockResolvedValue(undefined);
    authService.signInUp.mockResolvedValue({
      user: { id: 'u-1', email, isEmailVerified: true },
      workspace,
    });
    authService.verify.mockResolvedValue(tokens);
    userService.findUserByEmail.mockResolvedValue({ id: 'u-1', email });

    const module = await Test.createTestingModule({
      providers: [
        CloudflareAccessAuthResolver,
        { provide: CloudflareAccessService, useValue: cloudflareAccessService },
        { provide: AuthService, useValue: authService },
        { provide: UserService, useValue: userService },
        {
          provide: WorkspaceDomainsService,
          useValue: workspaceDomainsService,
        },
        { provide: UserSessionService, useValue: userSessionService },
      ],
    }).compile();

    resolver = module.get(CloudflareAccessAuthResolver);
  });

  it('signs in an existing member and issues a session', async () => {
    const result = await resolver.signInWithCloudflareAccess('https://x.io', {
      req,
    });

    expect(authService.signInUp).toHaveBeenCalledWith(
      expect.objectContaining({
        authParams: { provider: AuthProviderEnum.SSO },
        workspace,
      }),
    );
    expect(authService.verify).toHaveBeenCalledWith(
      email,
      'ws-1',
      AuthProviderEnum.SSO,
    );
    expect(userSessionService.issueSessionForTokenPair).toHaveBeenCalledWith({
      tokenPair: tokens.tokens,
      request: req,
      origin: 'sign_in',
    });
    expect(result).toEqual(tokens);
  });

  it('checks access against the workspace loaded with its approved access domains', async () => {
    const workspaceWithDomains = { id: 'ws-1', approvedAccessDomains: [] };

    authService.findWorkspaceForSignInUp.mockResolvedValue(
      workspaceWithDomains,
    );

    await resolver.signInWithCloudflareAccess('https://x.io', { req });

    expect(authService.findWorkspaceForSignInUp).toHaveBeenCalledWith({
      authProvider: AuthProviderEnum.SSO,
      email,
      workspaceId: 'ws-1',
    });
    expect(authService.checkAccessForSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: workspaceWithDomains }),
    );
  });

  it('passes a new-user payload with a verified email for unknown users', async () => {
    userService.findUserByEmail.mockResolvedValue(null);

    await resolver.signInWithCloudflareAccess('https://x.io', { req });

    expect(authService.formatUserDataPayload).toHaveBeenCalledWith(
      { email, isEmailAlreadyVerified: true },
      null,
    );
  });

  it('passes the names from the Access token to the new-user payload', async () => {
    cloudflareAccessService.verifyRequestOrThrow.mockResolvedValue({
      email,
      firstName: 'Jane',
      lastName: 'Doe',
    });
    userService.findUserByEmail.mockResolvedValue(null);

    await resolver.signInWithCloudflareAccess('https://x.io', { req });

    expect(authService.formatUserDataPayload).toHaveBeenCalledWith(
      {
        email,
        firstName: 'Jane',
        lastName: 'Doe',
        isEmailAlreadyVerified: true,
      },
      null,
    );
  });

  it('marks an unverified existing user as verified', async () => {
    authService.signInUp.mockResolvedValue({
      user: { id: 'u-1', email, isEmailVerified: false, passwordHash: '' },
      workspace,
    });

    await resolver.signInWithCloudflareAccess('https://x.io', { req });

    expect(userService.markEmailAsVerified).toHaveBeenCalledWith('u-1');
  });

  it('throws and issues no session when access is denied', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    authService.checkAccessForSignIn.mockRejectedValue(
      new AuthException('denied', 'FORBIDDEN_EXCEPTION' as never),
    );

    await expect(
      resolver.signInWithCloudflareAccess('https://x.io', { req }),
    ).rejects.toBeInstanceOf(AuthException);

    expect(authService.signInUp).not.toHaveBeenCalled();
    expect(userSessionService.issueSessionForTokenPair).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const message = warnSpy.mock.calls[0][0] as string;

    expect(message).toContain('cofertility.com');
    expect(message).toContain('FORBIDDEN_EXCEPTION');
    expect(message).not.toContain(email);
    warnSpy.mockRestore();
  });

  it('throws and issues no session when no workspace resolves', async () => {
    workspaceDomainsService.getWorkspaceByOriginOrDefaultWorkspace.mockResolvedValue(
      undefined,
    );

    await expect(
      resolver.signInWithCloudflareAccess('https://x.io', { req }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    expect(userSessionService.issueSessionForTokenPair).not.toHaveBeenCalled();
  });

  it('throws and issues no session when the JWT is rejected', async () => {
    cloudflareAccessService.verifyRequestOrThrow.mockRejectedValue(
      new AuthException('bad jwt', 'FORBIDDEN_EXCEPTION' as never),
    );

    await expect(
      resolver.signInWithCloudflareAccess('https://x.io', { req }),
    ).rejects.toBeInstanceOf(AuthException);

    expect(
      workspaceDomainsService.getWorkspaceByOriginOrDefaultWorkspace,
    ).not.toHaveBeenCalled();
    expect(userSessionService.issueSessionForTokenPair).not.toHaveBeenCalled();
  });
});
