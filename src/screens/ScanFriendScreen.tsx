import React, { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { Obscura } from '../native/ObscuraModule';
import { toast } from '../components/Toast';
import { QRScanner } from '../components/QRScanner';
import { primaryOnly } from '../state/devices';
import { errorMessage } from '../utils/log';

export function ScanFriendScreen() {
  const nav = useNavigation();
  const onCode = useCallback((code: string) => primaryOnly(() => Obscura.addFriendByCode(code))
    .then(() => { toast.success('Friend request sent'); nav.goBack(); return true; })
    .catch((e) => { toast.error(errorMessage(e)); return false; }), [nav]);
  return <QRScanner kind="friend" hint="Point at a friend's QR code" onCode={onCode} />;
}
