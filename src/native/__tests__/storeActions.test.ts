/**
 * The parts of `src/state/store.ts` that are reachable without a React renderer.
 *
 * zustand stores work outside React — `useStore.getState()` gives the actions directly — so the
 * store's *actions* are testable today. Its *subscriptions* are not: the event wiring lives inside
 * the `ObscuraBootstrap` hook, which needs a renderer this repo does not depend on yet (see
 * `jest.config.js`). That split is why this file is scoped to actions and named for them.
 *
 * Everything here depends on the kit double. `logout` calls across the bridge, so against the old
 * noop `Proxy` these assertions were either unreachable or vacuous.
 */

import { useStore } from '../../state/store';
import { getFakeBridge } from '../__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

/** The store is module-global, so reset it alongside the bridge. */
beforeEach(() => {
  useStore.getState().reset();
});

describe('logout', () => {
  it('clears session state and tells the kit', async () => {
    const s = useStore.getState();
    s.setAuthed(true);
    s._setUserId('user_self');
    s._setFriendsAndPending([{ userId: 'u', username: 'u', status: 'accepted' }], []);
    s._setEntries('story', [{ id: 'e', data: {}, sentAt: 1, authorUserId: 'u', authorDeviceId: 'd', viewedAt: null }]);

    await useStore.getState().logout();

    const after = useStore.getState();
    expect(after.authed).toBe(false);
    expect(after.myUserId).toBe('');
    expect(after.friends).toEqual([]);
    expect(after.entries).toEqual({});
    expect(bridge.__calls).toContain('logout');
  });

  /**
   * The behaviour worth pinning: local state is cleared **whether or not the native call
   * succeeded**. A user who taps logout must not remain logged in because the network was down —
   * and the `catch` that makes this true is dead code under a bridge that never rejects, which is
   * exactly what the noop `Proxy` was.
   */
  it('clears local state even when the kit call fails', async () => {
    bridge.__failNext('logout', 'SEND_FAILED', 'network down');
    useStore.getState().setAuthed(true);
    useStore.getState()._setUserId('user_self');

    await useStore.getState().logout();

    expect(useStore.getState().authed).toBe(false);
    expect(useStore.getState().myUserId).toBe('');
  });
});

describe('entry cache', () => {
  /**
   * `undefined` and `[]` mean different things: never-loaded versus loaded-and-empty. `store.ts`
   * relies on that distinction twice — `useModelEntries` fetches only when the slot is `undefined`,
   * and the bootstrap event handler refreshes only slots that already exist, so a model no screen
   * has opened is never fetched. Collapsing the two would turn every incoming event into a fetch of
   * every model.
   */
  it('distinguishes never-loaded from loaded-and-empty', () => {
    expect(useStore.getState().entries.story).toBeUndefined();

    useStore.getState()._setEntries('story', []);

    expect(useStore.getState().entries.story).toEqual([]);
    expect(useStore.getState().entries.story).not.toBeUndefined();
  });

  it('keeps models independent', () => {
    useStore.getState()._setEntries('story', [{ id: 'a', data: {}, sentAt: 1, authorUserId: 'u', authorDeviceId: 'd', viewedAt: null }]);
    useStore.getState()._setEntries('pix', []);

    expect(useStore.getState().entries.story).toHaveLength(1);
    expect(useStore.getState().entries.pix).toEqual([]);
    expect(useStore.getState().entries.directMessage).toBeUndefined();
  });
});
