import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../styles';

/** A disc with the first letter of `name`. */
export function Avatar({
  name,
  size = 44,
  background = colors.accent,
  color = colors.onAccent,
}: {
  name: string;
  size?: number;
  background?: string;
  color?: string;
}) {
  const initial = name[0]?.toUpperCase() ?? '?';
  const discStyle = { width: size, height: size, borderRadius: size / 2, backgroundColor: background };
  const textStyle = { color, fontSize: Math.round(size * 0.42) };
  return (
    <View style={[styles.base, discStyle]}>
      <Text style={[styles.initial, textStyle]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { justifyContent: 'center', alignItems: 'center' },
  initial: { fontWeight: '700' },
});
