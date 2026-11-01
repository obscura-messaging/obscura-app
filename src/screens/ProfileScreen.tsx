import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura, type ConnectionState } from '../native/ObscuraModule';
import { errorMessage, logError, getJsLog } from '../utils/log';
import { toast } from '../components/Toast';
import { confirm } from '../components/confirm';
import type { RootStackParamList } from '../navigation/types';
import { useSession, useIdentity, useModelEntries, saveEntry, logout } from '../state/store';
import { profileEntryId } from '../models/schema';
import { displayNameFor } from '../domain/friends';
import { s, colors } from '../styles';

const CONNECTION_LABELS: Record<ConnectionState, { color: string; label: string }> = {
  connected: { color: colors.connected, label: 'Connected' },
  connecting: { color: colors.connecting, label: 'Connecting…' },
  reconnecting: { color: colors.connecting, label: 'Reconnecting…' },
  disconnected: { color: colors.disconnected, label: 'Disconnected' },
};

const DEBUG_LOG_POLL_MS = 2000;

export function ProfileScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { myUserId, myUsername, connState } = useSession();
  const identity = useIdentity();
  const profiles = useModelEntries('profile');
  const ownProfile = profiles.find((p) => p.id === profileEntryId(myUserId));
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  // Fill the form from the saved profile once it loads, unless the user has started typing.
  const hydrated = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    if (hydrated.current || edited.current) return;
    if (ownProfile) {
      setDisplayName(ownProfile.data.displayName || myUsername);
      setBio(ownProfile.data.bio ?? '');
      hydrated.current = true;
    } else {
      setDisplayName(myUsername);
    }
  }, [ownProfile, myUsername]);

  const onChangeDisplayName = (t: string) => { edited.current = true; setDisplayName(t); };
  const onChangeBio = (t: string) => { edited.current = true; setBio(t); };

  useEffect(() => {
    if (!showLog) return;
    const refresh = () =>
      Obscura.getDebugLog()
        .then((native) => setDebugLog([...native, ...getJsLog()]))
        .catch((e) => logError('debugLog.fetch', e));
    refresh();
    const interval = setInterval(refresh, DEBUG_LOG_POLL_MS);
    return () => clearInterval(interval);
  }, [showLog]);

  const save = async () => {
    try {
      await saveEntry('profile', { displayName, bio }, profileEntryId(myUserId));
      toast.success('Profile updated');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const confirmLogout = async () => {
    if (await confirm('Log out?', 'You’ll need your username and password to sign back in.', 'Log out', true)) {
      await logout();
    }
  };

  // The heading is the friend-graph name; `displayName` is content its owner chose.
  const friendProfiles = profiles.flatMap((entry) => {
    const name = entry.authorUserId === myUserId ? null : displayNameFor(entry.authorUserId, identity);
    return name === null ? [] : [{ entry, name }];
  });

  const conn = CONNECTION_LABELS[connState];

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

        <TouchableOpacity style={pf.menuBtn} onPress={() => nav.navigate('Devices')}>
          <Text style={pf.codeBtnText}>Devices</Text>
        </TouchableOpacity>

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
  menuBtn: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, alignItems: 'center' },
  debugToggle: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 12, marginTop: 16 },
  codeBtnText: { color: colors.accent, fontWeight: '600' },
  logBox: { marginTop: 8 },
  logLine: { color: colors.textDim, fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 2 },
  dangerBtn: { borderWidth: 1, borderColor: colors.error, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 24, marginBottom: 32 },
  dangerBtnText: { color: colors.error, fontWeight: '700', fontSize: 16 },
});
