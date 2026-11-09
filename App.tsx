import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'react-native';

import { ObscuraBootstrap } from './src/state/store';
import { RootNavigator } from './src/navigation/RootNavigator';
import { ToastHost } from './src/components/Toast';
import { ConnectionBanner } from './src/components/ConnectionBanner';
import { colors } from './src/styles';

export default function App() {
  return (
    <SafeAreaProvider>
      <ObscuraBootstrap />
      <NavigationContainer
        theme={{
          dark: true,
          colors: {
            primary: colors.accent,
            background: colors.bg,
            card: colors.bg,
            text: colors.text,
            border: colors.border,
            notification: colors.accent,
          },
          fonts: {
            regular: { fontFamily: 'System', fontWeight: '400' },
            medium: { fontFamily: 'System', fontWeight: '500' },
            bold: { fontFamily: 'System', fontWeight: '700' },
            heavy: { fontFamily: 'System', fontWeight: '900' },
          },
        }}
      >
        <StatusBar barStyle="light-content" />
        <RootNavigator />
      </NavigationContainer>
      <ConnectionBanner />
      <ToastHost />
    </SafeAreaProvider>
  );
}
