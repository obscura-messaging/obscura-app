import React, { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { addFriend } from '../../state/store';
import { toast } from '../../state/toast';
import { errorMessage } from '../../utils/log';
import { confirmAndApproveLink } from '../confirm';
import { QRScanner } from '../components/QRScanner';

export function ScanFriendScreen() {
  const nav = useNavigation();
  const onCode = useCallback((code: string) => addFriend(code)
    .then(() => { toast.success('Friend request sent'); nav.goBack(); return true; })
    .catch(e => { toast.error(errorMessage(e)); return false; }), [nav]);
  return <QRScanner kind="friend" hint="Point at a friend's QR code" onCode={onCode} />;
}

export function ScanLinkScreen() {
  const nav = useNavigation();
  const onCode = useCallback(async (code: string) => {
    const linked = await confirmAndApproveLink(code);
    if (linked) nav.goBack();
    return linked;
  }, [nav]);
  return <QRScanner kind="link" hint="Point at the new device's link code" onCode={onCode} />;
}
