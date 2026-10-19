import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../styles';

/** A slide-down notice raised from anywhere through `toast` and rendered by the root `ToastHost`. */

type ToastType = 'success' | 'error';

interface ToastItem { id: number; message: string; type: ToastType; }

const COLORS: Record<ToastType, string> = {
  success: colors.success,
  error: colors.error,
};

const VISIBLE_MS = 2600;

let listener: ((t: ToastItem) => void) | null = null;
let counter = 0;

function showToast(message: string, type: ToastType) {
  if (!message) return;
  counter += 1;
  listener?.({ id: counter, message, type });
}

export const toast = {
  success: (message: string) => showToast(message, 'success'),
  error: (message: string) => showToast(message, 'error'),
};

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const [item, setItem] = useState<ToastItem | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    listener = (t) => setItem(t);
    return () => { listener = null; };
  }, []);

  useEffect(() => {
    if (!item) return;
    Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      Animated.timing(anim, { toValue: 0, duration: 220, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setItem(null); });
    }, VISIBLE_MS);
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [item, anim]);

  if (!item) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [-140, 0] });

  return (
    <View pointerEvents="none" style={[styles.host, { paddingTop: insets.top + 8 }]}>
      <Animated.View
        style={[styles.banner, { backgroundColor: COLORS[item.type], opacity: anim, transform: [{ translateY }] }]}
      >
        <Text style={styles.text} numberOfLines={3}>{item.message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 16, zIndex: 9999 },
  banner: {
    width: '100%', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 6,
  },
  text: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
