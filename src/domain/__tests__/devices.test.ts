import { readFileSync } from 'fs';
import { resolve } from 'path';
import { deviceLabel, linkCodeDeviceName, linkProblem, orderDevices } from '../devices';
import type { DeviceInfo } from '../../native/ObscuraModule';

const vectors: Array<{ deviceName: string; code: string }> = JSON.parse(readFileSync(
  resolve(__dirname, '../../../obscura-native/protocol/conformance/link.json'), 'utf8',
)).linkCodes;

const device = (deviceId: string, name: string | null, isPrimary = false): DeviceInfo =>
  ({ deviceId, name, isPrimary, isThisDevice: false });

describe('linkCodeDeviceName', () => {
  it('reads the device name from every conformance link code', () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const { deviceName, code } of vectors) expect(linkCodeDeviceName(code)).toBe(deviceName);
  });

  it('ignores surrounding whitespace from a paste', () => {
    expect(linkCodeDeviceName(`  ${vectors[0].code}\n`)).toBe(vectors[0].deviceName);
  });

  it('rejects text that is not a link code', () => {
    expect(linkCodeDeviceName('')).toBeNull();
    expect(linkCodeDeviceName('not a code!')).toBeNull();
    expect(linkCodeDeviceName(vectors[0].code + '=')).toBeNull();
    expect(linkCodeDeviceName(vectors[0].code.slice(0, -10))).toBeNull();
    expect(linkCodeDeviceName('CgA')).toBeNull();
  });
});

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
