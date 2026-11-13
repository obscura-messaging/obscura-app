import { errorCode, errorMessage } from '../errors';

describe('errorMessage & errorCode', () => {
  it('extracts error messages and codes from errors, objects, primitives, and null', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed');
    expect(errorMessage({ message: 42 })).toBe('[object Object]');
    expect(errorMessage(null)).toBe('null');
    expect(errorCode(Object.assign(new Error('boom'), { code: 'OFFLINE' }))).toBe('OFFLINE');
    expect(errorCode({ code: 123 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});
