import React, { useCallback, useEffect, useState } from 'react';
import { Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { CodeCard } from '../components/CodeCard';
import { confirm } from '../components/confirm';
import { linkProblem, type LinkProblem } from '../domain/devices';
import { cancelLink, linkThisDevice, resetAccount } from '../state/login';
import { errorMessage, logError } from '../utils/log';
import { colors } from '../styles';

type Phase = { kind: 'starting' } | { kind: 'waiting'; code: string } | { kind: 'resetting' } | LinkProblem;

interface LinkThisDeviceProps {
  username: string;
  password: string;
  onBack: () => void;
}

/** Shown when the account already has devices: the primary scans this device's code to link it. */
export function LinkThisDevice({ username, password, onBack }: LinkThisDeviceProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });

  const start = useCallback(() => {
    setPhase({ kind: 'starting' });
    linkThisDevice(username, password, (code) => setPhase({ kind: 'waiting', code }))
      .catch((e) => {
        const problem = linkProblem(e);
        if (problem !== null) setPhase(problem);
      });
  }, [username, password]);

  useEffect(() => {
    start();
    return () => { cancelLink().catch((e) => logError('link.cancel', e)); };
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

  return (
    <ScrollView contentContainerStyle={lk.box}>
      <Text style={lk.title}>Link this device</Text>
      <Text style={lk.body}>
        {username} is already signed in on another device. On your primary device, open Profile → Devices and scan
        this code.
      </Text>

      {phase.kind === 'waiting' && (
        <CodeCard kind="link" code={phase.code} caption="Waiting for approval…" copiedMessage="Link code copied" />
      )}
      {phase.kind === 'starting' && <Text style={lk.status}>Creating a link code…</Text>}
      {phase.kind === 'resetting' && <Text style={lk.status}>Resetting account…</Text>}
      {phase.kind === 'expired' && <Text style={lk.error}>The code expired or could not be used.</Text>}
      {phase.kind === 'failed' && <Text style={lk.error}>{phase.message}</Text>}

      {(phase.kind === 'expired' || phase.kind === 'failed') && (
        <TouchableOpacity style={lk.primaryBtn} onPress={start}>
          <Text style={lk.primaryBtnText}>Try again</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={lk.secondaryBtn} onPress={onBack}>
        <Text style={lk.secondaryBtnText}>Back</Text>
      </TouchableOpacity>
      <TouchableOpacity style={lk.resetBtn} onPress={reset} disabled={phase.kind === 'starting' || phase.kind === 'resetting'}>
        <Text style={lk.resetText}>Lost your primary device? Reset account</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const lk = StyleSheet.create({
  box: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 8 },
  body: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', marginBottom: 8 },
  status: { color: colors.textDim, fontSize: 14, marginVertical: 24 },
  error: { color: colors.error, fontSize: 14, textAlign: 'center', marginVertical: 24 },
  primaryBtn: { alignSelf: 'stretch', backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center' },
  primaryBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    alignSelf: 'stretch', borderWidth: 1, borderColor: colors.surfaceMuted, borderRadius: 12, padding: 14,
    alignItems: 'center', marginTop: 24,
  },
  secondaryBtnText: { color: colors.text, fontWeight: '600', fontSize: 16 },
  resetBtn: { marginTop: 20, padding: 8 },
  resetText: { color: colors.error, fontSize: 13, fontWeight: '600' },
});
