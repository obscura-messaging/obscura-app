import React, { useEffect, useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';
import { copyToClipboard, loadDebugLog, useSession } from '../../state/store';
import { toast } from '../../state/toast';
import { errorMessage, logError } from '../../utils/log';
import { useUi2Theme } from '../store';
import { CONNECTION_LABEL, connectionDot } from '../connection';
import { Hint, InfoRow, Note, Page, PillButton, SectionLabel } from '../components/Page';

const LOG_POLL_MS = 2000;

export function StatusScreen() {
  const theme = useUi2Theme();
  const { connState, myUsername, isPrimary } = useSession();
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    if (!showLog) return undefined;
    const refresh = () => loadDebugLog().then(setLog).catch(e => logError('debugLog.fetch', e));
    refresh();
    const timer = setInterval(refresh, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [showLog]);

  // claude: always the latest log, oldest line first, so a saved copy reads top to bottom
  const logText = async () => (await loadDebugLog()).join('\n');
  const share = async () => {
    try {
      await Share.share({ message: await logText() });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const copy = async () => {
    try {
      await copyToClipboard(await logText());
      toast.success('Log copied');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Page title="Status">
      <InfoRow label="Connection">
        <View style={styles.state}>
          <View style={[styles.dot, { backgroundColor: connectionDot(connState, theme.muted) }]} />
          <Note>{CONNECTION_LABEL[connState]}</Note>
        </View>
      </InfoRow>
      <InfoRow label="Account"><Note>{`@${myUsername}`}</Note></InfoRow>
      {isPrimary !== null && <InfoRow label="This device"><Note>{isPrimary ? 'Primary' : 'Linked'}</Note></InfoRow>}

      <SectionLabel>Debug log</SectionLabel>
      <View style={styles.actions}>
        <View style={styles.action}><PillButton label={showLog ? 'Hide' : 'Show'} tone="plain" onPress={() => setShowLog(!showLog)} /></View>
        <View style={styles.action}><PillButton label="Share" tone="plain" onPress={share} /></View>
        <View style={styles.action}><PillButton label="Copy" tone="plain" onPress={copy} /></View>
      </View>
      {showLog && log.length === 0 && <Hint>Nothing logged yet.</Hint>}
      {showLog && log.length > 0 && (
        <View style={styles.log}>
          {log.slice().reverse().map((line, i) => (
            <Text key={i} style={[styles.line, { color: theme.muted }]} selectable>{line}</Text>
          ))}
        </View>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  state: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
  log: { marginTop: 4 },
  line: { fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 2 },
});
