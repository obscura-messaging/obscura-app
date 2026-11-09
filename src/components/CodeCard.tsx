import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { copyToClipboard } from '../state/store';
import { toast } from './Toast';
import { encodeQR, type QRKind } from '../domain/qr';
import { errorMessage } from '../utils/log';
import { colors, type Colors } from '../styles';
import { useLegacyColors } from '../ui2/legacyColors';

interface CodeCardProps {
  kind: QRKind;
  /** Null while the code loads. */
  code: string | null;
  caption: string;
  copiedMessage: string;
}

/** A code as a QR, with the text in a pill that copies it. */
export function CodeCard({ kind, code, caption, copiedMessage }: CodeCardProps) {
  const c = useLegacyColors(colors);
  const cc = useMemo(() => makeStyles(c), [c]);
  const copy = async () => {
    if (code === null) return;
    try { await copyToClipboard(code); toast.success(copiedMessage); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <>
      <View style={cc.qrCard}>
        {code !== null
          ? <QRCode value={encodeQR(kind, code)} size={216} backgroundColor="transparent" color={c.text} />
          : <Text style={cc.dim}>Loading…</Text>}
      </View>
      <Text style={cc.caption}>{caption}</Text>
      {code !== null && (
        <TouchableOpacity style={cc.codePill} onPress={copy}>
          <Text style={cc.codeText} numberOfLines={1}>{code}</Text>
          <Text style={cc.copyHint}>Copy</Text>
        </TouchableOpacity>
      )}
    </>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  qrCard: {
    width: 256, height: 256, borderRadius: 20, backgroundColor: c.surface,
    justifyContent: 'center', alignItems: 'center', marginTop: 12,
    borderWidth: 1, borderColor: c.border,
  },
  dim: { color: c.textDim, fontSize: 14 },
  caption: { color: c.textDim, fontSize: 13, marginTop: 12, textAlign: 'center' },
  codePill: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16,
    backgroundColor: c.surface, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1, borderColor: c.border, maxWidth: '100%',
  },
  codeText: { color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  copyHint: { color: c.accent, fontSize: 13, fontWeight: '700' },
});
