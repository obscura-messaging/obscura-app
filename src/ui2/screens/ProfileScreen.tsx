import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import QRCode from 'react-native-qrcode-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { encodeQR } from '../../domain/qr';
import { copyToClipboard, getFriendCode, logout, useProfiles, useSession } from '../../state/store';
import { loadDevices } from '../../state/devices';
import { toast } from '../../state/toast';
import { errorMessage, logError } from '../../utils/log';
import type { RootStackParamList } from '../../navigation/types';
import { useUi2, useUi2Theme } from '../store';
import { FONT } from '../font';
import { CONNECTION_LABEL, connectionDot } from '../connection';
import { Avatar } from '../components/Avatar';
import { EditProfileSheet, ThemeSheet } from '../components/ProfileSheets';

export function ProfileScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const theme = useUi2Theme();
  const on = theme.onSecondary;
  const insets = useSafeAreaInsets();
  const { myUserId, myUsername, connState } = useSession();
  const own = useProfiles().find(p => p.userId === myUserId);
  const emoji = useUi2(s => s.emoji);
  const color = useUi2(s => s.color);
  const [sheet, setSheet] = useState<'theme' | 'edit' | null>(null);
  const closeSheet = () => setSheet(null);
  const [code, setCode] = useState<string | null>(null);
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const [hint, setHint] = useState('');
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getFriendCode().then(setCode).catch(e => logError('getFriendCode', e));
    loadDevices().then(d => setDeviceCount(d.length)).catch(e => logError('loadDevices', e));
  }, []);
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(''), 2400);
  };

  const copy = async () => {
    if (code === null) return;
    try {
      await copyToClipboard(code);
      showHint('Your code is copied');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const confirmLogout = () => {
    Alert.alert('Log out?', 'You’ll need your username and password to sign back in.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => { logout().catch(e => toast.error(errorMessage(e))); } },
    ]);
  };

  const chevron = (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path d="M9 5l7 7-7 7" stroke={theme.muted} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
  const option = (label: string, onPress: (() => void) | undefined, note?: React.ReactNode, danger = false) => (
    <TouchableOpacity
      key={label}
      style={[styles.option, { backgroundColor: theme.paper, borderColor: theme.outline }]}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text style={[styles.optionLabel, { color: danger ? theme.alert : theme.ink }]}>{label}</Text>
      {note}
      {!danger && chevron}
    </TouchableOpacity>
  );
  const noteStyle = [styles.note, { color: theme.muted }];
  const statusDot = connectionDot(connState, theme.muted);

  return (
    <ScrollView
      style={{ backgroundColor: theme.sky }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top }]}
      showsVerticalScrollIndicator={false}
    >
      <TouchableOpacity style={[styles.iconBtn, styles.themeBtn, { top: insets.top + 2 }]} onPress={() => setSheet('theme')} accessibilityLabel="Theme">
        <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"
            stroke={on.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
          />
          <Circle cx="7.5" cy="11" r="1.3" fill={on.ink} />
          <Circle cx="10.5" cy="7" r="1.3" fill={on.ink} />
          <Circle cx="15.5" cy="7.5" r="1.3" fill={on.ink} />
        </Svg>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.iconBtn, styles.editBtn, { top: insets.top + 2 }]}
        onPress={() => setSheet('edit')}
        accessibilityLabel="Edit profile"
      >
        <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
          <Path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" stroke={on.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
          <Path d="M13.5 6.5l4 4" stroke={on.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </TouchableOpacity>

      <View style={styles.me}>
        <View style={styles.meAvatar}>
          <Avatar
            name={myUsername} size={92} radius={26} outline={on.outline} ink={on.ink} emoji={emoji} background={color ?? undefined}
          />
        </View>
        <Text style={[styles.meName, { color: on.ink }]}>{own?.displayName || myUsername}</Text>
        <Text style={[styles.meHandle, { color: on.inkSoft }]}>@{myUsername}</Text>
        {own?.bio ? <Text style={[styles.meBio, { color: on.ink }]}>{own.bio}</Text> : null}
      </View>

      <View style={[styles.sheet, { backgroundColor: theme.paper, paddingBottom: insets.bottom + 100 }]}>
        <View style={styles.qrWrap}>
          <TouchableOpacity
            style={[styles.qrCard, { backgroundColor: theme.sun, borderColor: theme.outline, boxShadow: `0 4px 0 ${theme.outline}` }]}
            onPress={() => showHint('Friends can scan this to add you')}
            accessibilityLabel="Your friend code"
          >
            <View style={styles.qr}>
              {code !== null && <QRCode value={encodeQR('friend', code)} size={136} color="#000000" backgroundColor="#FFFFFF" />}
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.codeBtn, { backgroundColor: theme.paper, borderColor: theme.outline, boxShadow: `0 3px 0 ${theme.outline}` }]}
            onPress={copy}
            accessibilityLabel="Copy your friend code"
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Path d="M8 6l-6 6 6 6M16 6l6 6-6 6" stroke={theme.ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </TouchableOpacity>
        </View>
        <Text style={[styles.hint, { color: theme.inkSoft }]}>{hint}</Text>
        <View style={styles.options}>
          {option('Friends', () => nav.navigate('AddFriend'))}
          {option('Devices', () => nav.navigate('Devices'), deviceCount !== null && <Text style={noteStyle}>{deviceCount} linked</Text>)}
          {option('Status', () => nav.navigate('Status'), (
            <View style={styles.noteRow}>
              <View style={[styles.dot, { backgroundColor: statusDot }]} />
              <Text style={noteStyle}>{CONNECTION_LABEL[connState]}</Text>
            </View>
          ))}
          {option('Log out', confirmLogout, undefined, true)}
        </View>
      </View>
      <ThemeSheet visible={sheet === 'theme'} theme={theme} onDone={closeSheet} />
      <EditProfileSheet
        visible={sheet === 'edit'} theme={theme} username={myUsername}
        displayName={own?.displayName || myUsername} bio={own?.bio ?? ''} onDone={closeSheet}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1 },
  iconBtn: { position: 'absolute', zIndex: 2, width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  themeBtn: { left: 12 },
  editBtn: { right: 12 },
  me: { alignItems: 'center', gap: 2, paddingTop: 4, paddingHorizontal: 16, paddingBottom: 20 },
  meAvatar: { marginBottom: 8 },
  meName: { fontSize: 22, fontFamily: FONT[900] },
  meHandle: { fontSize: 13, fontFamily: FONT[800] },
  meBio: { fontSize: 13, fontFamily: FONT[700], maxWidth: 260, textAlign: 'center', marginTop: 4 },
  sheet: {
    flexGrow: 1, marginTop: 26, borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingTop: 18, paddingHorizontal: 16, gap: 14,
  },
  qrWrap: { alignSelf: 'center', marginTop: -47, zIndex: 3 },
  qrCard: { padding: 14, borderWidth: 2.5, borderRadius: 24 },
  qr: { width: 160, height: 160, backgroundColor: '#FFFFFF', borderRadius: 6, padding: 12 },
  codeBtn: {
    position: 'absolute', right: -14, top: -14, width: 40, height: 40, borderRadius: 20, borderWidth: 2.5,
    alignItems: 'center', justifyContent: 'center',
  },
  hint: { alignSelf: 'center', minHeight: 18, fontSize: 13, fontFamily: FONT[800], textAlign: 'center' },
  options: { gap: 8 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingHorizontal: 16, borderWidth: 2, borderRadius: 999,
  },
  optionLabel: { flex: 1, fontSize: 14, fontFamily: FONT[800] },
  note: { fontSize: 12, fontFamily: FONT[800] },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
