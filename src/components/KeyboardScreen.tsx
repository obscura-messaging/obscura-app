import React from 'react';
import {
  KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard, Platform,
  View, StyleSheet,
} from 'react-native';

/**
 * Lifts a non-scrolling screen above the keyboard and dismisses it on a tap outside an input.
 * Android 15 no longer resizes the window for the keyboard, so this must. Scrolling screens use
 * `keyboardShouldPersistTaps` instead: the touchable here would swallow their scroll gestures.
 */
export function KeyboardScreen({ children }: { children: React.ReactNode }) {
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
        <View style={styles.flex}>{children}</View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
