import { resolveLogicFunctionApiUrl } from 'src/engine/core-modules/logic-function/logic-function-executor/utils/resolve-logic-function-api-url.util';

describe('resolveLogicFunctionApiUrl', () => {
  it('uses LOGIC_FUNCTION_API_URL when set', () => {
    expect(
      resolveLogicFunctionApiUrl({
        logicFunctionApiUrl: 'http://localhost:3000/',
        serverUrl: 'https://crm.example.com',
      }),
    ).toBe('http://localhost:3000');
  });

  it('falls back to SERVER_URL when LOGIC_FUNCTION_API_URL is not set', () => {
    expect(
      resolveLogicFunctionApiUrl({
        logicFunctionApiUrl: undefined,
        serverUrl: 'https://crm.example.com/',
      }),
    ).toBe('https://crm.example.com');
  });

  it('falls back to SERVER_URL when LOGIC_FUNCTION_API_URL is empty', () => {
    expect(
      resolveLogicFunctionApiUrl({
        logicFunctionApiUrl: '',
        serverUrl: 'https://crm.example.com',
      }),
    ).toBe('https://crm.example.com');
  });
});
