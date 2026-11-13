import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MIN_PASSWORD_LENGTH, credentialsProblem, logIn, register } from '../state/login';
import { KeyboardScreen } from '../components/KeyboardScreen';
import { LinkThisDevice } from '../components/LinkThisDevice';
import { errorMessage } from '../domain/errors';
import { s, colors } from '../styles';

type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting'; label: string }
  | { kind: 'error'; message: string }
  | { kind: 'linking' };

export function AuthScreen() {
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

  if (phase.kind === 'linking') {
    return (
      <SafeAreaView style={s.container}>
        <LinkThisDevice username={username} password={password} onBack={() => setPhase({ kind: 'idle' })} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <KeyboardScreen>
        <View style={a.box}>
          <Image source={require('../assets/logo.png')} style={a.logo} resizeMode="contain" />
          <Text style={a.subtitle}>Encrypted everything</Text>
          {phase.kind === 'error' && <Text style={a.error}>{phase.message}</Text>}
          {phase.kind === 'submitting' && <Text style={a.progress}>{phase.label}</Text>}
          <TextInput style={s.input} placeholder="Username" placeholderTextColor={colors.textDim}
            value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} editable={!busy} />
          <TextInput style={s.input} placeholder={`Password (${MIN_PASSWORD_LENGTH}+ chars)`}
            placeholderTextColor={colors.textDim} value={password} onChangeText={setPassword} secureTextEntry editable={!busy} />
          <View style={a.buttons}>
            <TouchableOpacity style={[s.primaryBtn, busy && s.btnDisabled]} onPress={onLogIn} disabled={busy}>
              <Text style={s.primaryBtnText}>Log in</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.secondaryBtn, busy && s.btnDisabled]} onPress={onRegister} disabled={busy}>
              <Text style={s.secondaryBtnText}>Sign up</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardScreen>
    </SafeAreaView>
  );
}

const a = StyleSheet.create({
  box: { flex: 1, justifyContent: 'center', padding: 32 },
  logo: { width: 260, height: 60, alignSelf: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.textDim, textAlign: 'center', marginBottom: 32 },
  error: { color: colors.error, textAlign: 'center', marginBottom: 12, fontSize: 13 },
  progress: { color: colors.textSecondary, textAlign: 'center', marginBottom: 12, fontSize: 13 },
  buttons: { flexDirection: 'column', gap: 12, marginTop: 8 },
});
