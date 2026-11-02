import React, { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { toast } from '../components/Toast';
import { QRScanner } from '../components/QRScanner';
import { addFriend } from '../state/store';
import { errorMessage } from '../utils/log';

export function ScanFriendScreen() {
  const nav = useNavigation();
  const onCode = useCallback((code: string) => addFriend(code)
    .then(() => { toast.success('Friend request sent'); nav.goBack(); return true; })
    .catch((e) => { toast.error(errorMessage(e)); return false; }), [nav]);
  return <QRScanner kind="friend" hint="Point at a friend's QR code" onCode={onCode} />;
}
