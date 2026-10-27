import { createAtomState } from '@/ui/utilities/state/jotai/utils/createAtomState';

export const isCloudflareAccessSessionState = createAtomState<boolean>({
  key: 'isCloudflareAccessSessionState',
  defaultValue: false,
  useLocalStorage: true,
  localStorageOptions: { getOnInit: true },
});
