import { isNonEmptyString } from '@sniptt/guards';

import { cleanServerUrl } from 'src/utils/clean-server-url';

export const resolveLogicFunctionApiUrl = ({
  logicFunctionApiUrl,
  serverUrl,
}: {
  logicFunctionApiUrl?: string;
  serverUrl?: string;
}): string | undefined =>
  cleanServerUrl(
    isNonEmptyString(logicFunctionApiUrl) ? logicFunctionApiUrl : serverUrl,
  );
