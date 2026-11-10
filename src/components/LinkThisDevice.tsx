import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { CodeCard } from './CodeCard';
import { confirm } from './confirm';
import { linkProblem, type LinkProblem } from '../domain/devices';
import { cancelLink, cancelPendingLinkOnUnmount, linkThisDevice, resetAccount } from '../state/login';
import { errorMessage, logError } from '../utils/log';
import { sharedStyles, colors, type Colors } from '../styles';
import { useLegacyColors } from '../ui2/legacyColors';

type Phase = { kind: 'starting' } | { kind: 'waiting'; code: string } | { kind: 'resetting' } | LinkProblem;

interface LinkThisDeviceProps {
  username: string;
  password: string;
  onBack: () => void;
}

/** Shown when the account already has devices: the primary scans this device's code to link it. */
export function LinkThisDevice({ username, password, onBack }: LinkThisDeviceProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const c = useLegacyColors(colors);
  const s = useMemo(() => sharedStyles(c), [c]);
  const styles = useMemo(() => makeStyles(c), [c]);

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
    return () => {
      cancelPendingLinkOnUnmount().catch((e) => logError('link.cancel', e));
    };
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
    <ScrollView contentContainerStyle={styles.box}>
      <Text style={styles.title}>Link this device</Text>
      <Text style={styles.body}>
        {username} is already signed in on another device. On your primary device, open Profile → Devices and scan
        this code.
      </Text>

      {phase.kind === 'waiting' && (
        <CodeCard kind="link" code={phase.code} caption="Waiting for approval…" copiedMessage="Link code copied" />
      )}
      {phase.kind === 'starting' && <Text style={styles.status}>Creating a link code…</Text>}
      {phase.kind === 'resetting' && <Text style={styles.status}>Resetting account…</Text>}
      {phase.kind === 'expired' && <Text style={styles.error}>The code expired or could not be used.</Text>}
      {phase.kind === 'failed' && <Text style={styles.error}>{phase.message}</Text>}

      {(phase.kind === 'expired' || phase.kind === 'failed') && (
        <TouchableOpacity style={[s.primaryBtn, styles.stretch]} onPress={start}>
          <Text style={s.primaryBtnText}>Try again</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={[s.secondaryBtn, styles.stretch, styles.backBtn]} onPress={onBack}>
        <Text style={s.secondaryBtnText}>Back</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.resetBtn} onPress={reset} disabled={phase.kind === 'starting' || phase.kind === 'resetting'}>
        <Text style={styles.resetText}>Lost your primary device? Reset account</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  box: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  title: { color: c.text, fontSize: 22, fontWeight: '700', marginBottom: 8 },
  body: { color: c.textSecondary, fontSize: 14, textAlign: 'center', marginBottom: 8 },
  status: { color: c.textDim, fontSize: 14, marginVertical: 24 },
  error: { color: c.error, fontSize: 14, textAlign: 'center', marginVertical: 24 },
  stretch: { alignSelf: 'stretch' },
  backBtn: { marginTop: 24 },
  resetBtn: { marginTop: 20, padding: 8 },
  resetText: { color: c.error, fontSize: 13, fontWeight: '600' },
});
