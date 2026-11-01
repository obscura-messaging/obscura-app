import React, { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { QRScanner } from '../components/QRScanner';
import { confirmAndApproveLink } from './DevicesScreen';

export function ScanLinkScreen() {
  const nav = useNavigation();
  const onCode = useCallback(async (code: string) => {
    const linked = await confirmAndApproveLink(code);
    if (linked) nav.goBack();
    return linked;
  }, [nav]);
  return <QRScanner kind="link" hint="Point at the new device's link code" onCode={onCode} />;
}
