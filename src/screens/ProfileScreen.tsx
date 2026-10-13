import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert, StyleSheet,
} from 'react-native';
import { Obscura } from '../native/ObscuraModule';
import { logError, getJsLog } from '../utils/log';
import { toast } from '../components/Toast';
import { useSession, useModelEntries, saveEntry } from '../state/store';
import { profileEntryId } from '../models/schema';
import { displayNameFor } from '../domain/friends';
import { s, colors } from '../styles';
import type { ConnectionState } from '../native/ObscuraModule';

// connState → colored dot + label. Same mapping on iOS and Android since it
// reads the shared `connState` store value fed by the `connectionChanged`
// bridge event (both platforms emit it).
const CONN_META: Record<ConnectionState, { color: string; label: string }> = {
  connected: { color: colors.connected, label: 'Connected' },
  connecting: { color: colors.connecting, label: 'Connecting…' },
  reconnecting: { color: colors.connecting, label: 'Reconnecting…' },
  disconnected: { color: colors.disconnected, label: 'Disconnected' },
};

export function ProfileScreen() {
  const { myUserId, myUsername, friends, connState, logout } = useSession();
  const profiles = useModelEntries('profile');
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const identity = { myUserId, myUsername, friends };

  // Profile ids are device-independent. The drain accepts `profile_<x>` only
  // from authenticated user `<x>`.
  const ownProfile = profiles.find(p => p.id === profileEntryId(myUserId));

  // Hydrate the editable fields from the saved profile once it's available,
  // falling back to the username for a brand-new profile. `hydrated` stops it
  // re-running (so clearing a field doesn't refill it); `edited` guards the
  // async gap so we never clobber input the user typed before entries loaded.
  const hydrated = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    if (hydrated.current || edited.current) return;
    if (ownProfile) {
      setDisplayName((ownProfile.data.displayName as string) || myUsername || '');
      setBio((ownProfile.data.bio as string) || '');
      hydrated.current = true;
    } else if (myUsername) {
      // No saved profile yet — seed the name from the handle, but keep
      // listening in case a saved profile arrives after entries load.
      setDisplayName(myUsername);
    }
  }, [ownProfile, myUsername]);

  const onChangeDisplayName = (t: string) => { edited.current = true; setDisplayName(t); };
  const onChangeBio = (t: string) => { edited.current = true; setBio(t); };

  // Poll the debug log only while it's visible.
  useEffect(() => {
    if (showLog) {
      // Merge the native (kit) debug log with the JS-side log so swallowed
      // errors routed through logError() are visible on-device too.
      const refresh = () =>
        Obscura.getDebugLog()
          .then((native) => setDebugLog([...native, ...getJsLog()]))
          .catch((e) => logError('debugLog.fetch', e));
      refresh();
      const interval = setInterval(refresh, 2000);
      return () => clearInterval(interval);
    }
  }, [showLog]);

  const save = async () => {
    try {
      await saveEntry('profile', { displayName, bio }, profileEntryId(myUserId));
      toast.success('Profile updated');
    } catch (e: any) { toast.error(e.message); }
  };

  const confirmLogout = () => {
    Alert.alert(
      'Log out?',
      'You’ll need your username and password to sign back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log out', style: 'destructive', onPress: () => { logout(); } },
      ],
    );
  };

  // Everyone else's profile, keyed on the AUTHENTICATED owner rather than on `authorDeviceId` —
  // which excluded only the device that last wrote, so my own profile reappeared here as soon as my
  // other device saved it. The heading is the friend-graph username (an identity the kit proved);
  // `displayName` below it is the profile's content, which its owner is entitled to choose.
  const friendProfiles = profiles
    .map(p => ({ entry: p, name: displayNameFor(p.authorUserId, identity) }))
    .filter((p): p is { entry: typeof p.entry; name: string } =>
      p.name !== null && p.entry.id !== profileEntryId(myUserId));

  const conn = CONN_META[connState] ?? CONN_META.disconnected;

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView style={pf.screen} keyboardShouldPersistTaps="handled">
        <Text style={pf.sectionTitle}>edit profile</Text>
        <TextInput style={s.input} placeholder="Display name" placeholderTextColor={colors.textDim}
          value={displayName} onChangeText={onChangeDisplayName} />
        <TextInput style={s.input} placeholder="Bio" placeholderTextColor={colors.textDim}
          value={bio} onChangeText={onChangeBio} />
        <TouchableOpacity style={pf.smallBtn} onPress={save}>
          <Text style={pf.smallBtnText}>Save</Text>
        </TouchableOpacity>

        {friendProfiles.length > 0 && (<>
          <Text style={pf.sectionTitle}>friend profiles</Text>
          {friendProfiles.map(({ entry, name }) => (
            <View key={entry.id} style={pf.storyCard}>
              <Text style={pf.storyAuthor}>{name}</Text>
              {entry.data.displayName ? <Text style={pf.storyContent}>{entry.data.displayName}</Text> : null}
              {entry.data.bio ? <Text style={pf.storyContent}>{entry.data.bio}</Text> : null}
            </View>
          ))}
        </>)}

        <Text style={pf.sectionTitle}>status</Text>
        <View style={pf.statusRow}>
          <Text style={[pf.statusDot, { color: conn.color }]}>●</Text>
          <Text style={pf.statusText}>{conn.label}</Text>
        </View>

        <Text style={pf.sectionTitle}>account</Text>
        <Text style={pf.settingsLabel}>{myUsername}</Text>
        <Text style={pf.hint}>{myUserId.slice(0, 16)}...</Text>

        <TouchableOpacity style={pf.debugToggle} onPress={() => setShowLog(!showLog)}>
          <Text style={pf.codeBtnText}>{showLog ? 'Hide debug log' : 'Show debug log'}</Text>
        </TouchableOpacity>

        {showLog && debugLog.length > 0 && (
          <View style={pf.logBox}>
            {debugLog.slice().reverse().map((line, i) => (
              <Text key={i} style={pf.logLine}>{line}</Text>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={pf.dangerBtn}
          onPress={confirmLogout}
        >
          <Text style={pf.dangerBtnText}>Log out</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const pf = StyleSheet.create({
  screen: { flex: 1, padding: 16 },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginTop: 20, marginBottom: 8, textTransform: 'uppercase' },
  smallBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  smallBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 14 },
  storyCard: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 8 },
  storyAuthor: { color: colors.accent, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  storyContent: { color: colors.text, fontSize: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 12 },
  statusDot: { fontSize: 14 },
  statusText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  settingsLabel: { color: colors.text, fontSize: 18, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: 12 },
  debugToggle: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 12, marginTop: 16 },
  codeBtnText: { color: colors.accent, fontWeight: '600' },
  logBox: { marginTop: 8 },
  logLine: { color: colors.textDim, fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 2 },
  dangerBtn: { borderWidth: 1, borderColor: colors.error, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 24, marginBottom: 32 },
  dangerBtnText: { color: colors.error, fontWeight: '700', fontSize: 16 },
});
