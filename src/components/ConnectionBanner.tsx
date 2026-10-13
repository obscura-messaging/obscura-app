import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '../state/store';
import { colors } from '../styles';

/**
 * A "Reconnecting…" pill while signed in but not connected for longer than `GRACE_MS`, so launch and
 * quick reconnects do not flash it. One label, because a sustained outage cycles through the states.
 */

const GRACE_MS = 1200;

export function ConnectionBanner() {
  const insets = useSafeAreaInsets();
  const { authed, connState } = useSession();

  const notConnected = authed && connState !== 'connected';

  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!notConnected) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [notConnected]);

  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: shown ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [shown, anim]);

  // Stays mounted so hiding animates.
  return (
    <View pointerEvents="none" style={[styles.host, { top: insets.top + 52 }]}>
      <Animated.View
        style={[
          styles.pill,
          {
            opacity: anim,
            transform: [
              { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
            ],
          },
        ]}
      >
        <View style={[styles.dot, { backgroundColor: colors.connecting }]} />
        <Text style={styles.label}>Reconnecting…</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
