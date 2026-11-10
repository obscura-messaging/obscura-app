import React, { useCallback, useEffect, useState } from 'react';
import {
  Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { linkProblem, type LinkProblem } from '../../domain/devices';
import { encodeQR } from '../../domain/qr';
import {
  MIN_PASSWORD_LENGTH, cancelLink, cancelPendingLinkOnUnmount, credentialsProblem, linkThisDevice, logIn, register,
  resetAccount,
} from '../../state/login';
import { copyToClipboard } from '../../state/store';
import { toast } from '../../state/toast';
import { errorMessage, logError } from '../../utils/log';
import { useUi2Theme } from '../store';
import { confirm } from '../confirm';
import { Hint, PillButton, PillInput } from '../components/Page';

// claude: login, sign-up and linking rules are copied from src/screens/AuthScreen.tsx and
// src/components/LinkThisDevice.tsx; only the look is new.

type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting'; label: string }
  | { kind: 'error'; message: string }
  | { kind: 'linking' };

export function AuthScreen() {
  const theme = useUi2Theme();
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'submitting';

  const submit = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    const problem = credentialsProblem(username, password);
    if (problem !== null) { setPhase({ kind: 'error', message: problem }); return; }
    setPhase({ kind: 'submitting', label });
    try { await action(); } catch (e) { setPhase({ kind: 'error', message: errorMessage(e) }); }
  };
  const onLogIn = () => submit('Logging in…', async () => {
    switch (await logIn(username, password)) {
      case 'invalidCredentials': setPhase({ kind: 'error', message: 'Wrong username or password' }); return;
      case 'linkRequired': setPhase({ kind: 'linking' }); return;
      case 'signedIn': return;
    }
  });
  const onRegister = () => submit('Registering…', () => register(username, password));

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.sky, paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <TouchableOpacity style={styles.top} activeOpacity={1} onPress={Keyboard.dismiss} accessible={false}>
        <Text style={[styles.wordmark, { color: theme.onSecondary.ink }]}>OBSCURA</Text>
      </TouchableOpacity>
      <ScrollView
        style={[styles.sheet, { backgroundColor: theme.paper }]}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {phase.kind === 'linking' ? (
          <LinkThisDevice username={username} password={password} onBack={() => setPhase({ kind: 'idle' })} />
        ) : (
          <>
            {phase.kind === 'error' && <Hint danger>{phase.message}</Hint>}
            {phase.kind === 'submitting' && <Hint>{phase.label}</Hint>}
            <View style={styles.field}>
              <PillInput placeholder="Username" value={username} onChangeText={setUsername} editable={!busy} />
            </View>
            <View style={styles.field}>
              <PillInput
                placeholder={`Password (${MIN_PASSWORD_LENGTH}+ chars)`} value={password} onChangeText={setPassword}
                secureTextEntry editable={!busy}
              />
            </View>
            <PillButton label="Log in" onPress={onLogIn} disabled={busy} />
            <PillButton label="Sign up" tone="plain" onPress={onRegister} disabled={busy} />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type LinkPhase = { kind: 'starting' } | { kind: 'waiting'; code: string } | { kind: 'resetting' } | LinkProblem;

// claude: the account already has devices, so the primary scans this device's code to link it.
function LinkThisDevice({ username, password, onBack }: { username: string; password: string; onBack: () => void }) {
  const theme = useUi2Theme();
  const [phase, setPhase] = useState<LinkPhase>({ kind: 'starting' });

  const start = useCallback(() => {
    setPhase({ kind: 'starting' });
    linkThisDevice(username, password, code => setPhase({ kind: 'waiting', code }))
      .catch(e => {
        const problem = linkProblem(e);
        if (problem !== null) setPhase(problem);
      });
  }, [username, password]);

  useEffect(() => {
    start();
    return () => { cancelPendingLinkOnUnmount().catch(e => logError('link.cancel', e)); };
  }, [start]);

  const reset = async () => {
    const confirmed = await confirm(
      'Reset account?',
      'Every device signed in to this account is signed out and this phone becomes your new primary. '
        + 'Friends will see that your safety number changed. This cannot be undone.',
      'Reset',
      true,
    );
    if (!confirmed) return;
    setPhase({ kind: 'resetting' });
    try {
      await cancelLink();
      await resetAccount(username, password);
    } catch (e) {
      setPhase({ kind: 'failed', message: errorMessage(e) });
    }
  };

  const copy = async (code: string) => {
    try { await copyToClipboard(code); toast.success('Link code copied'); } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <>
      <Text style={[styles.title, { color: theme.ink }]}>Link this device</Text>
      <Hint>{`${username} is already signed in on another device. On your primary device, open Profile → Devices and scan this code.`}</Hint>
      {phase.kind === 'waiting' && (
        <>
          <View style={[styles.qrCard, { backgroundColor: theme.sun, borderColor: theme.outline, boxShadow: `0 4px 0 ${theme.outline}` }]}>
            <View style={styles.qr}>
              <QRCode value={encodeQR('link', phase.code)} size={176} color="#000000" backgroundColor="#FFFFFF" />
            </View>
          </View>
          <Hint>Waiting for approval…</Hint>
          <PillButton label="Copy code" tone="plain" onPress={() => copy(phase.code)} />
        </>
      )}
      {phase.kind === 'starting' && <Hint>Creating a link code…</Hint>}
      {phase.kind === 'resetting' && <Hint>Resetting account…</Hint>}
      {phase.kind === 'expired' && <Hint danger>The code expired or could not be used.</Hint>}
      {phase.kind === 'failed' && <Hint danger>{phase.message}</Hint>}
      {(phase.kind === 'expired' || phase.kind === 'failed') && <PillButton label="Try again" onPress={start} />}
      <PillButton label="Back" tone="plain" onPress={onBack} />
      <TouchableOpacity style={styles.reset} onPress={reset} disabled={phase.kind === 'starting' || phase.kind === 'resetting'}>
        <Text style={[styles.resetText, { color: theme.alert }]}>Lost your primary device? Reset account</Text>
      </TouchableOpacity>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { minHeight: 180, flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  wordmark: { fontSize: 44, fontWeight: '900', letterSpacing: 3 },
  sheet: { flexGrow: 0, borderTopLeftRadius: 26, borderTopRightRadius: 26 },
  content: { padding: 16, paddingTop: 24, gap: 10 },
  field: { flexDirection: 'row' },
  title: { fontSize: 18, fontWeight: '900' },
  qrCard: { alignSelf: 'center', padding: 14, borderWidth: 2.5, borderRadius: 24, marginVertical: 8 },
  qr: { backgroundColor: '#FFFFFF', borderRadius: 6, padding: 12 },
  reset: { alignSelf: 'center', padding: 8 },
  resetText: { fontSize: 13, fontWeight: '800' },
});
