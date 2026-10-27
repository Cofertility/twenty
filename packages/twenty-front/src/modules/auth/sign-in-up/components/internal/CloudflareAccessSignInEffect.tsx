import { useMarkSessionActive } from '@/auth/hooks/useMarkSessionActive';
import { isAppEffectRedirectEnabledState } from '@/auth/states/isAppEffectRedirectEnabledState';
import { isCloudflareAccessSignInAttemptedState } from '@/auth/states/isCloudflareAccessSignInAttemptedState';
import { isCloudflareAccessSessionState } from '@/auth/states/isCloudflareAccessSessionState';
import { useSetAtomState } from '@/ui/utilities/state/jotai/hooks/useSetAtomState';
import { useLoadCurrentUser } from '@/users/hooks/useLoadCurrentUser';
import { gql, type TypedDocumentNode } from '@apollo/client';
import { useMutation } from '@apollo/client/react';
import { useStore } from 'jotai';
import { useEffect } from 'react';
import { isDefined } from 'twenty-shared/utils';
import { logError } from '~/utils/logError';

type SignInWithCloudflareAccessData = {
  signInWithCloudflareAccess: {
    tokens: {
      accessOrWorkspaceAgnosticToken: { token: string };
    };
  };
};

const SIGN_IN_WITH_CLOUDFLARE_ACCESS: TypedDocumentNode<
  SignInWithCloudflareAccessData,
  { origin: string }
> = gql`
  mutation SignInWithCloudflareAccess($origin: String!) {
    signInWithCloudflareAccess(origin: $origin) {
      tokens {
        accessOrWorkspaceAgnosticToken {
          token
        }
      }
    }
  }
`;

export const CloudflareAccessSignInEffect = () => {
  const markSessionActive = useMarkSessionActive();
  const { loadCurrentUser } = useLoadCurrentUser();
  const setIsAppEffectRedirectEnabled = useSetAtomState(
    isAppEffectRedirectEnabledState,
  );
  const setIsCloudflareAccessSession = useSetAtomState(
    isCloudflareAccessSessionState,
  );
  const [signInWithCloudflareAccess] = useMutation(
    SIGN_IN_WITH_CLOUDFLARE_ACCESS,
  );
  const store = useStore();

  useEffect(() => {
    // Store-level guard so StrictMode remounts and re-renders fire the mutation once
    if (store.get(isCloudflareAccessSignInAttemptedState.atom)) {
      return;
    }
    store.set(isCloudflareAccessSignInAttemptedState.atom, true);

    const run = async () => {
      // Keeps PageChangeEffect from consuming returnToPath while the server sets the session cookie
      setIsAppEffectRedirectEnabled(false);

      try {
        const { data } = await signInWithCloudflareAccess({
          variables: { origin: window.location.origin },
        });

        if (!isDefined(data?.signInWithCloudflareAccess?.tokens)) {
          return;
        }

        setIsCloudflareAccessSession(true);
        markSessionActive();
        // The boot-time user query already ran while logged out, so it will not refetch
        await loadCurrentUser();
      } catch (error: unknown) {
        // Expected when Cloudflare Access is off (local dev): fall back to the normal form
        logError(error);
      } finally {
        setIsAppEffectRedirectEnabled(true);
      }
    };

    void run();
  }, [
    loadCurrentUser,
    markSessionActive,
    setIsAppEffectRedirectEnabled,
    setIsCloudflareAccessSession,
    signInWithCloudflareAccess,
    store,
  ]);

  return <></>;
};
