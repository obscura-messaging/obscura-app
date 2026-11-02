import { useEffect, useState } from 'react';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { saveEntry } from './store';

/** Real-time typing indicator and message sending for a 1:1 conversation. */

export function notifyTyping(friendUserId: string, convId: string): void {
  Obscura.sendTyping([friendUserId], convId).catch((e) => logError('typing.send', e));
}

export async function sendChatMessage(convId: string, friendUserId: string, content: string): Promise<void> {
  await Obscura.stopTyping([friendUserId], convId);
  await saveEntry('directMessage', { conversationId: convId, content });
}

export function usePeerTyping(convId: string, friendUserId: string): boolean {
  const [peerTyping, setPeerTyping] = useState(false);
  useEffect(() => {
    setPeerTyping(false);
    const unsubscribe = onObscuraEvent((event) => {
      if (event.type === 'messageReceived' && event.model === 'directMessage') {
        setPeerTyping(false);
      } else if (event.type === 'typingChanged' && event.conversationId === convId) {
        // Anyone can signal under this id; only this conversation's friend counts.
        setPeerTyping(event.userIds.includes(friendUserId));
      }
    });
    Obscura.observeTyping(convId).catch((e) => logError('typing.observe', e));
    return () => {
      unsubscribe();
      Obscura.stopObservingTyping(convId).catch((e) => logError('typing.unobserve', e));
    };
  }, [convId, friendUserId]);
  return peerTyping;
}
