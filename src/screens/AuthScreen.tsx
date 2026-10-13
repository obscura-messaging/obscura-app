import React, { useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { Obscura } from '../native/ObscuraModule';
import { useSession } from '../state/store';
import { logIn } from '../state/login';
import { KeyboardScreen } from '../components/KeyboardScreen';
import { s, colors } from '../styles';

export function AuthScreen() {
  const { setAuthed } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');

  const register = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Registering...');
    try {
      await Obscura.registerUser(username, password);
      await Obscura.connect();
      setAuthed(true);
    } catch (e: any) { setStatus(e.message || 'Registration failed'); }
  };

  const login = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Logging in...');
    try {
      if (!(await logIn(username, password))) setStatus('Wrong username or password');
    } catch (e: any) { setStatus(e.message || 'Login failed'); }
  };

  return (
    <SafeAreaView style={s.container}>
      <KeyboardScreen>
      <View style={a.box}>
        <Image source={require('../assets/logo.png')} style={a.logo} resizeMode="contain" />
        <Text style={a.subtitle}>Encrypted everything</Text>
        {status ? <Text style={a.status}>{status}</Text> : null}
        <TextInput style={s.input} placeholder="Username" placeholderTextColor={colors.textDim}
          value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
        <TextInput style={s.input} placeholder="Password (12+ chars)" placeholderTextColor={colors.textDim}
          value={password} onChangeText={setPassword} secureTextEntry />
        <View style={a.buttons}>
          <TouchableOpacity style={a.primaryBtn} onPress={login}>
            <Text style={a.primaryBtnText}>Log in</Text>
          </TouchableOpacity>
          <TouchableOpacity style={a.secondaryBtn} onPress={register}>
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
