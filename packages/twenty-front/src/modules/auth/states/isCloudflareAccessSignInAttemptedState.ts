import { createAtomState } from '@/ui/utilities/state/jotai/utils/createAtomState';

export const isCloudflareAccessSignInAttemptedState = createAtomState<boolean>({
  key: 'isCloudflareAccessSignInAttemptedState',
  defaultValue: false,
});
