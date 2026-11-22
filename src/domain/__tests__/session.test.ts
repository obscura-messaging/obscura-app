import { deviceRole, toMe } from '../session';

describe('deviceRole', () => {
  it('maps the kit answer to a role, and no answer to unknown', () => {
    expect(deviceRole(true)).toBe('primary');
    expect(deviceRole(false)).toBe('linked');
    expect(deviceRole(null)).toBe('unknown');
  });
});

describe('toMe', () => {
  it('builds an identity only when every part is present', () => {
    expect(toMe('u', 'name', 'd')).toEqual({ userId: 'u', username: 'name', deviceId: 'd' });
    expect(toMe(null, 'name', 'd')).toBeNull();
    expect(toMe('u', null, 'd')).toBeNull();
    expect(toMe('u', 'name', '')).toBeNull();
  });
});
