import { deviceLabel, linkProblem, orderDevices } from '../devices';
import type { DeviceInfo } from '../../native/ObscuraModule';

const device = (deviceId: string, name: string | null, isPrimary = false): DeviceInfo =>
  ({ deviceId, name, isPrimary, isThisDevice: false });

describe('orderDevices', () => {
  it('puts the primary first, then sorts by name', () => {
    const ordered = orderDevices([device('c', 'Tablet'), device('b', null), device('a', 'Phone', true)]);
    expect(ordered.map((d) => d.deviceId)).toEqual(['a', 'c', 'b']);
  });

  it('labels a nameless device', () => {
    expect(deviceLabel({ name: null })).toBe('Unnamed device');
    expect(deviceLabel({ name: 'Pixel' })).toBe('Pixel');
  });
});

describe('linkProblem', () => {
  const rejection = (code: string) => Object.assign(new Error('boom'), { code });

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
