import React, { useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { MIN_PASSWORD_LENGTH, credentialsProblem, logIn, register } from '../state/login';
import { KeyboardScreen } from '../components/KeyboardScreen';
import { LinkThisDevice } from './LinkThisDevice';
import { errorMessage } from '../utils/log';
import { s, colors } from '../styles';

export function AuthScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [linking, setLinking] = useState(false);

  const submit = async (progress: string, action: () => Promise<void>) => {
    const problem = credentialsProblem(username, password);
    if (problem !== null) { setStatus(problem); return; }
    setStatus(progress);
    try { await action(); } catch (e) { setStatus(errorMessage(e)); }
  };

  const onLogIn = () => submit('Logging in...', async () => {
    switch (await logIn(username, password)) {
      case 'invalidCredentials': setStatus('Wrong username or password'); return;
      case 'linkRequired': setStatus(''); setLinking(true); return;
      case 'signedIn': return;
    }
  });
  const onRegister = () => submit('Registering...', () => register(username, password));

  if (linking) {
    return (
      <SafeAreaView style={s.container}>
        <LinkThisDevice username={username} password={password} onBack={() => setLinking(false)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <KeyboardScreen>
        <View style={a.box}>
          <Image source={require('../assets/logo.png')} style={a.logo} resizeMode="contain" />
          <Text style={a.subtitle}>Encrypted everything</Text>
          {status ? <Text style={a.status}>{status}</Text> : null}
          <TextInput style={s.input} placeholder="Username" placeholderTextColor={colors.textDim}
            value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
          <TextInput style={s.input} placeholder={`Password (${MIN_PASSWORD_LENGTH}+ chars)`}
            placeholderTextColor={colors.textDim} value={password} onChangeText={setPassword} secureTextEntry />
          <View style={a.buttons}>
            <TouchableOpacity style={a.primaryBtn} onPress={onLogIn}>
              <Text style={a.primaryBtnText}>Log in</Text>
            </TouchableOpacity>
            <TouchableOpacity style={a.secondaryBtn} onPress={onRegister}>
              <Text style={a.secondaryBtnText}>Sign up</Text>
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
  status: { color: colors.error, textAlign: 'center', marginBottom: 12, fontSize: 13 },
  buttons: { flexDirection: 'column', gap: 12, marginTop: 8 },
  primaryBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center' },
  primaryBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  secondaryBtn: { borderWidth: 1, borderColor: colors.surfaceMuted, borderRadius: 12, padding: 14, alignItems: 'center' },
  secondaryBtnText: { color: colors.text, fontWeight: '600', fontSize: 16 },
});
