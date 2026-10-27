import { Logger, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { Args, Context, Mutation } from '@nestjs/graphql';

import { isNonEmptyString } from '@sniptt/guards';
import { type Request } from 'express';
import { assertIsDefinedOrThrow } from 'twenty-shared/utils';

import { MetadataResolver } from 'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator';
import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { AuthTokens } from 'src/engine/core-modules/auth/dto/auth-tokens.dto';
import { AuthGraphqlApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter';
import { AuthService } from 'src/engine/core-modules/auth/services/auth.service';
import { CloudflareAccessService } from 'src/engine/core-modules/auth/services/cloudflare-access.service';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { PreventNestToAutoLogGraphqlErrorsFilter } from 'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter';
import { ResolverValidationPipe } from 'src/engine/core-modules/graphql/pipes/resolver-validation.pipe';
import { UserSessionService } from 'src/engine/core-modules/user-session/services/user-session.service';
import { UserService } from 'src/engine/core-modules/user/services/user.service';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';
import { AllowSuspendedWorkspace } from 'src/engine/decorators/auth/allow-suspended-workspace.decorator';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { PublicEndpointGuard } from 'src/engine/guards/public-endpoint.guard';

@UsePipes(ResolverValidationPipe)
@MetadataResolver()
@UseFilters(
  AuthGraphqlApiExceptionFilter,
  PreventNestToAutoLogGraphqlErrorsFilter,
)
export class CloudflareAccessAuthResolver {
  private readonly logger = new Logger(CloudflareAccessAuthResolver.name);

  constructor(
    private readonly cloudflareAccessService: CloudflareAccessService,
    private readonly authService: AuthService,
    private readonly userService: UserService,
    private readonly workspaceDomainsService: WorkspaceDomainsService,
    private readonly userSessionService: UserSessionService,
  ) {}

  @Mutation(() => AuthTokens)
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  @AllowSuspendedWorkspace()
  async signInWithCloudflareAccess(
    @Args('origin') origin: string,
    @Context() context: { req: Request },
  ): Promise<AuthTokens> {
    const { email, firstName, lastName } =
      await this.cloudflareAccessService.verifyRequestOrThrow(context.req);

    const emailDomain = email.split('@')[1] ?? 'unknown';

    const currentWorkspace =
      await this.workspaceDomainsService.getWorkspaceByOriginOrDefaultWorkspace(
        origin,
      );

    try {
      assertIsDefinedOrThrow(
        currentWorkspace,
        new AuthException(
          'Workspace not found',
          AuthExceptionCode.WORKSPACE_NOT_FOUND,
        ),
      );
    } catch (error) {
      this.logRejection(error, emailDomain);
      throw error;
    }

    const invitation = await this.authService.findInvitationForSignInUp({
      currentWorkspace,
      email,
    });

    const existingUser = await this.userService.findUserByEmail(email);

    const { userData } = this.authService.formatUserDataPayload(
      { email, firstName, lastName, isEmailAlreadyVerified: true },
      existingUser,
    );

    try {
      await this.authService.checkAccessForSignIn({
        userData,
        invitation,
        workspace: currentWorkspace,
      });
    } catch (error) {
      this.logRejection(error, emailDomain);
      throw error;
    }

    const { workspace, user } = await this.authService.signInUp({
      userData,
      workspace: currentWorkspace,
      invitation,
      authParams: { provider: AuthProviderEnum.SSO },
    });

    if (!user.isEmailVerified && !isNonEmptyString(user.passwordHash)) {
      await this.userService.markEmailAsVerified(user.id);
    }

    const authTokens = await this.authService.verify(
      user.email,
      workspace.id,
      AuthProviderEnum.SSO,
    );

    await this.userSessionService.issueSessionForTokenPair({
      tokenPair: authTokens.tokens,
      request: context.req,
      origin: 'sign_in',
    });

    return authTokens;
  }

  private logRejection(error: unknown, emailDomain: string) {
    const code =
      error instanceof AuthException ? error.code : 'UNKNOWN_EXCEPTION';

    this.logger.warn(
      `Cloudflare Access sign-in rejected for email domain ${emailDomain}: ${code}`,
    );
  }
}
