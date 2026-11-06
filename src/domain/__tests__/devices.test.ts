import {
  deviceLabel, errorCode, errorMessage, linkProblem, orderDevices, type DeviceInfo,
} from '../devices';

const device = (deviceId: string, name: string | null, isPrimary = false): DeviceInfo =>
  ({ deviceId, name, isPrimary, isThisDevice: false });

describe('orderDevices', () => {
  it('puts the primary first, then sorts by name and breaks ties by deviceId', () => {
    const ordered = orderDevices([
      device('c', 'Tablet'),
      device('d', null),
      device('b', null),
      device('a', 'Phone', true),
    ]);
    expect(ordered.map((d) => d.deviceId)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('labels a nameless device', () => {
    expect(deviceLabel({ name: null })).toBe('Unnamed device');
    expect(deviceLabel({ name: 'Pixel' })).toBe('Pixel');
  });
});

describe('linkProblem, errorMessage & errorCode', () => {
  const rejection = (code: string) => Object.assign(new Error('boom'), { code });

  it('extracts error messages and codes from errors, objects, primitives, and null', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed');
    expect(errorMessage({ message: 42 })).toBe('[object Object]');
    expect(errorMessage(null)).toBe('null');
    expect(errorCode(rejection('OFFLINE'))).toBe('OFFLINE');
    expect(errorCode({ code: 123 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });

  it('treats a cancelled link as no problem', () => {
    expect(linkProblem(rejection('CANCELLED'))).toBeNull();
  });

  it('reports a failed link session as expired', () => {
    expect(linkProblem(rejection('LINK_FAILED'))).toEqual({ kind: 'expired' });
  });

  it('reports anything else with its message', () => {
    expect(linkProblem(rejection('HTTP_ERROR'))).toEqual({ kind: 'failed', message: 'boom' });
  });
});
