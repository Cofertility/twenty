import { gql } from '@apollo/client';
import { MockedProvider } from '@apollo/client/testing/react';
import { render, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { StrictMode } from 'react';

import { CloudflareAccessSignInEffect } from '@/auth/sign-in-up/components/internal/CloudflareAccessSignInEffect';
import { isCloudflareAccessSessionState } from '@/auth/states/isCloudflareAccessSessionState';
import {
  jotaiStore,
  resetJotaiStore,
} from '@/ui/utilities/state/jotai/jotaiStore';

const mockMarkSessionActive = jest.fn();

jest.mock('@/auth/hooks/useMarkSessionActive', () => ({
  useMarkSessionActive: () => mockMarkSessionActive,
}));

const mockLoadCurrentUser = jest.fn();

jest.mock('@/users/hooks/useLoadCurrentUser', () => ({
  useLoadCurrentUser: () => ({ loadCurrentUser: mockLoadCurrentUser }),
}));

jest.mock('~/utils/logError', () => ({ logError: jest.fn() }));

const SIGN_IN_WITH_CLOUDFLARE_ACCESS = gql`
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

const buildRequest = () => ({
  query: SIGN_IN_WITH_CLOUDFLARE_ACCESS,
  variables: { origin: window.location.origin },
});

const renderEffect = (mocks: any[]) => {
  const tree = (
    <StrictMode>
      <JotaiProvider store={jotaiStore}>
        <MockedProvider mocks={mocks}>
          <CloudflareAccessSignInEffect />
        </MockedProvider>
      </JotaiProvider>
    </StrictMode>
  );
  const utils = render(tree);
  return { ...utils, rerenderTree: () => utils.rerender(tree) };
};

describe('CloudflareAccessSignInEffect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetJotaiStore();
    jotaiStore.set(isCloudflareAccessSessionState.atom, false);
  });

  it('marks the session active, loads the user and flags a Cloudflare session on success', async () => {
    renderEffect([
      {
        request: buildRequest(),
        result: {
          data: {
            signInWithCloudflareAccess: {
              __typename: 'AuthTokens',
              tokens: {
                __typename: 'AuthTokenPair',
                accessOrWorkspaceAgnosticToken: {
                  __typename: 'AuthToken',
                  token: 'access-token',
                },
              },
            },
          },
        },
      },
    ]);

    await waitFor(() => expect(mockLoadCurrentUser).toHaveBeenCalledTimes(1));
    expect(mockMarkSessionActive).toHaveBeenCalledTimes(1);
    expect(jotaiStore.get(isCloudflareAccessSessionState.atom)).toBe(true);
  });

  it('leaves the session alone when the mutation fails', async () => {
    const { logError } = jest.requireMock('~/utils/logError');

    renderEffect([
      { request: buildRequest(), error: new Error('Cloudflare Access off') },
    ]);

    await waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    expect(mockMarkSessionActive).not.toHaveBeenCalled();
    expect(mockLoadCurrentUser).not.toHaveBeenCalled();
    expect(jotaiStore.get(isCloudflareAccessSessionState.atom)).toBe(false);
  });

  it('calls the mutation once across StrictMode remounts and re-renders', async () => {
    const resultFn = jest.fn(() => ({
      data: {
        signInWithCloudflareAccess: {
          __typename: 'AuthTokens',
          tokens: {
            __typename: 'AuthTokenPair',
            accessOrWorkspaceAgnosticToken: {
              __typename: 'AuthToken',
              token: 'access-token',
            },
          },
        },
      },
    }));

    const { rerenderTree, unmount } = renderEffect([
      { request: buildRequest(), result: resultFn, maxUsageCount: 5 },
    ]);

    rerenderTree();
    unmount();

    // Mount again with the same Jotai store
    renderEffect([
      { request: buildRequest(), result: resultFn, maxUsageCount: 5 },
    ]);

    await waitFor(() => expect(mockMarkSessionActive).toHaveBeenCalledTimes(1));
    expect(resultFn).toHaveBeenCalledTimes(1);
  });
});
