import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { errorMessage } from '../domain/errors';
import { logError } from '../utils/log';
import { toast } from '../components/Toast';
import { confirm } from '../components/confirm';
import type { RootStackParamList } from '../navigation/types';
import {
  useSession,
  useIdentity,
  useProfiles,
  saveOwnProfile,
  logout,
  loadDebugLog,
  type ConnectionState,
} from '../state/store';
import { friendProfileEntries } from '../domain/friends';
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
  const insets = useSafeAreaInsets();
  const { myUserId, myUsername, connState } = useSession();
  const identity = useIdentity();
  const profiles = useProfiles();
  const ownProfile = profiles.find(p => p.userId === myUserId);
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');
  const [saving, setSaving] = useState(false);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  // Fill the form from the saved profile once it loads, unless the user has started typing.
  const hydrated = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    if (hydrated.current || edited.current) return;
    if (ownProfile) {
      setDisplayName(ownProfile.displayName || myUsername);
      setBio(ownProfile.bio ?? '');
      hydrated.current = true;
    } else {
      setDisplayName(myUsername);
    }
  }, [ownProfile, myUsername]);

  const onChangeDisplayName = (t: string) => {
    edited.current = true;
    setDisplayName(t);
  };
  const onChangeBio = (t: string) => {
    edited.current = true;
    setBio(t);
  };

  useEffect(() => {
    if (!showLog) return;
    const refresh = () =>
      loadDebugLog()
        .then(setDebugLog)
        .catch(e => logError('debugLog.fetch', e));
    refresh();
    const interval = setInterval(refresh, DEBUG_LOG_POLL_MS);
    return () => clearInterval(interval);
  }, [showLog]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saveOwnProfile(displayName, bio);
      toast.success('Profile updated');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const confirmLogout = async () => {
    if (
      await confirm(
        'Log out?',
        'You’ll need your username and password to sign back in.',
        'Log out',
        true,
      )
    ) {
      await logout();
    }
  };

  // The heading is the friend-graph name; `displayName` is content its owner chose.
  const friendProfiles = friendProfileEntries(profiles, identity);

  const conn = CONNECTION_LABELS[connState];

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={pf.screen}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={s.sectionTitle}>edit profile</Text>
        <TextInput
          style={s.input}
          placeholder="Display name"
          placeholderTextColor={colors.textDim}
          value={displayName}
          onChangeText={onChangeDisplayName}
        />
        <TextInput
          style={s.input}
          placeholder="Bio"
          placeholderTextColor={colors.textDim}
          value={bio}
          onChangeText={onChangeBio}
        />
        <TouchableOpacity
          style={[s.primaryBtn, saving && s.btnDisabled]}
          onPress={save}
          disabled={saving}
        >
          <Text style={s.primaryBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
        </TouchableOpacity>

        {friendProfiles.length > 0 && (
          <>
            <Text style={s.sectionTitle}>friend profiles</Text>
            {friendProfiles.map(({ entry, name }) => (
              <View key={entry.userId} style={pf.profileCard}>
                <Text style={pf.profileAuthor}>{name}</Text>
                {entry.displayName ? (
                  <Text style={pf.profileContent}>{entry.displayName}</Text>
                ) : null}
                {entry.bio ? <Text style={pf.profileContent}>{entry.bio}</Text> : null}
              </View>
            ))}
          </>
        )}

        <Text style={s.sectionTitle}>status</Text>
        <View style={pf.statusRow}>
          <Text style={[pf.statusDot, { color: conn.color }]}>●</Text>
          <Text style={pf.statusText}>{conn.label}</Text>
        </View>

        <Text style={s.sectionTitle}>account</Text>
        <Text style={pf.settingsLabel}>{myUsername}</Text>
        <Text style={pf.hint}>{myUserId.slice(0, 16)}...</Text>

        <TouchableOpacity style={s.secondaryBtn} onPress={() => nav.navigate('Devices')}>
          <Text style={pf.codeBtnText}>Devices</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.secondaryBtn, pf.debugToggle]}
          onPress={() => setShowLog(!showLog)}
        >
          <Text style={pf.codeBtnText}>{showLog ? 'Hide debug log' : 'Show debug log'}</Text>
        </TouchableOpacity>

        {showLog && debugLog.length > 0 && (
          <View style={pf.logBox}>
            {debugLog
              .slice()
              .reverse()
              .map((line, i) => (
                <Text key={i} style={pf.logLine}>
                  {line}
                </Text>
              ))}
          </View>
        )}

        <TouchableOpacity style={[s.dangerBtn, pf.logoutBtn]} onPress={confirmLogout}>
          <Text style={s.dangerBtnText}>Log out</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const pf = StyleSheet.create({
  screen: { flex: 1, padding: 16 },
  profileCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  profileAuthor: { color: colors.accent, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  profileContent: { color: colors.text, fontSize: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 12 },
  statusDot: { fontSize: 14 },
  statusText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  settingsLabel: { color: colors.text, fontSize: 18, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: 12 },
  debugToggle: { marginBottom: 12, marginTop: 12 },
  codeBtnText: { color: colors.accent, fontWeight: '600', fontSize: 15 },
  logBox: { marginTop: 8 },
  logLine: {
    color: colors.textDim,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 2,
  },
  logoutBtn: { marginTop: 24, marginBottom: 32 },
});
