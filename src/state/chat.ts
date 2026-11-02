import { useEffect, useState } from 'react';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { refreshMessages } from './store';

/** Real-time typing indicator and message sending for a 1:1 conversation. */

export function notifyTyping(friendUserId: string, prevText: string, nextText: string): void {
  if (nextText.length > 0) {
    Obscura.sendTyping(friendUserId).catch((e) => logError('typing.send', e));
  } else if (prevText.length > 0) {
    Obscura.stopTyping(friendUserId).catch((e) => logError('typing.stop', e));
  }
}

export async function sendChatMessage(friendUserId: string, content: string): Promise<void> {
  await Obscura.stopTyping(friendUserId);
  try {
    await Obscura.sendMessage(friendUserId, content);
  } finally {
    await refreshMessages();
  }
}

export function usePeerTyping(friendUserId: string): boolean {
  const [peerTyping, setPeerTyping] = useState(false);
  useEffect(() => {
    setPeerTyping(false);
    const unsubscribe = onObscuraEvent((event) => {
      if (event.type === 'messageReceived' && event.model === 'directMessage') {
        setPeerTyping(false);
      } else if (event.type === 'typingChanged' && event.peerUserId === friendUserId) {
        setPeerTyping(event.typing);
      }
    });
    Obscura.observeTyping(friendUserId).catch((e) => logError('typing.observe', e));
    return () => {
      unsubscribe();
      Obscura.stopObservingTyping(friendUserId).catch((e) => logError('typing.unobserve', e));
    };
  }, [friendUserId]);
  return peerTyping;
}
