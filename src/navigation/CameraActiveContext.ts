import { createContext, useContext } from 'react';

/**
 * Whether the record camera may hold a live session: MainTabs is focused and the app is foreground.
 * It stays live across a tab swipe and stops under a modal, notably ScanFriend, whose own camera
 * would exceed CameraX's use-case limit.
 */
export const CameraActiveContext = createContext<boolean>(true);

export function useCameraActive(): boolean {
  return useContext(CameraActiveContext);
}
