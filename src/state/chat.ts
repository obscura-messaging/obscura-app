import { useEffect, useState } from 'react';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { conversationId } from '../domain/chats';
import { logError } from '../utils/log';
import { refreshMessages, useStore } from './store';

/** Real-time typing indicator and message sending for a 1:1 conversation. */

export function notifyTyping(friendUserId: string, convId: string, prevText: string, nextText: string): void {
  if (nextText.length > 0) {
    Obscura.sendTyping([friendUserId], convId).catch((e) => logError('typing.send', e));
  } else if (prevText.length > 0) {
    Obscura.stopTyping([friendUserId], convId).catch((e) => logError('typing.stop', e));
  }
}

export async function sendChatMessage(friendUserId: string, content: string): Promise<void> {
  const convId = conversationId(useStore.getState().myUserId, friendUserId);
  await Obscura.stopTyping([friendUserId], convId);
  try {
    await Obscura.sendMessage(friendUserId, content);
  } finally {
    await refreshMessages();
  }
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
