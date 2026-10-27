import React, { useEffect } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createMaterialTopTabNavigator, type MaterialTopTabBarProps } from '@react-navigation/material-top-tabs';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationOptions, NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useSession, useStore } from '../state/store';
import { useAppActive } from '../hooks/useAppActive';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { colors } from '../styles';
import { CameraActiveContext } from './CameraActiveContext';

import { AuthScreen } from '../screens/AuthScreen';
import { CameraScreen } from '../screens/CameraScreen';
import { ChatListScreen } from '../screens/ChatListScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { PhotoPreviewScreen } from '../screens/PhotoPreviewScreen';
import { RecipientPicker } from '../screens/RecipientPicker';
import { StoryViewer } from '../screens/StoriesScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { AddFriendScreen } from '../screens/AddFriendScreen';
import { ScanFriendScreen } from '../screens/ScanFriendScreen';
import { DevicesScreen } from '../screens/DevicesScreen';
import { ScanLinkScreen } from '../screens/ScanLinkScreen';
import { CameraIcon, ChatIcon } from '../components/icons';

import type { RootStackParamList, MainTabParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTab = createMaterialTopTabNavigator<MainTabParamList>();

/** Floats over the pager so the camera preview runs underneath it. */
function BottomTabBar({ state, navigation }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();
  const onCamera = state.routes[state.index]?.name === 'Camera';
  const barDynamic = {
    paddingBottom: insets.bottom + 10,
    backgroundColor: onCamera ? 'rgba(0,0,0,0.58)' : colors.bg,
    borderTopColor: onCamera ? 'transparent' : colors.border,
  };
  return (
    <View style={[tabStyles.bar, barDynamic]}>
      {state.routes.map((route, i) => {
        const focused = state.index === i;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };
        const tint = focused ? colors.accent : colors.textDim;
        const Icon = route.name === 'Camera' ? CameraIcon : ChatIcon;
        return (
          <TouchableOpacity key={route.key} style={tabStyles.tab} onPress={onPress} accessibilityLabel={route.name}>
            <Icon size={27} color={tint} strokeWidth={focused ? 2.4 : 2} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function MainTabs() {
  const focused = useIsFocused();
  const appActive = useAppActive();

  return (
    <CameraActiveContext.Provider value={focused && appActive}>
      <MainTab.Navigator
        initialRouteName="Camera"
        tabBarPosition="bottom"
        tabBar={BottomTabBar}
        // Both stay mounted so the camera preview is live as it slides in.
        screenOptions={{ lazy: false, swipeEnabled: true }}
      >
        <MainTab.Screen name="Chats" component={ChatListScreen} />
        <MainTab.Screen name="Camera" component={CameraScreen} />
      </MainTab.Navigator>
    </CameraActiveContext.Provider>
  );
}

function SplashScreen() {
  return <View style={styles.splash} />;
}

function headerOptions(title: string): NativeStackNavigationOptions {
  return {
    headerShown: true,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.accent,
    headerTitleStyle: { color: colors.text, fontWeight: '700' },
    title,
  };
}

export function RootNavigator() {
  const { authed } = useSession();
  const bootstrapped = useStore((s) => s.bootstrapped);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Notification taps: pulled once on cold start, and as an event while running.
  useEffect(() => {
    if (!authed) return;
    const route = (screen: string) => {
      if (screen === 'chat') nav.navigate('MainTabs', { screen: 'Chats' });
    };
    Obscura.getLaunchIntent()
      .then((intent) => { if (intent) route(intent.screen); })
      .catch((e) => logError('launchIntent', e));
    return onObscuraEvent((event) => {
      if (event.type === 'launchedFrom') route(event.screen);
    });
  }, [authed, nav]);

  return (
    <RootStack.Navigator screenOptions={{ headerShown: false, headerBackButtonDisplayMode: 'minimal' }}>
      {!bootstrapped ? (
        // Avoids flashing the auth screen at a signed-in user.
        <RootStack.Screen name="Splash" component={SplashScreen} />
      ) : !authed ? (
        <RootStack.Screen name="Auth" component={AuthScreen} />
      ) : (
        <>
          <RootStack.Screen name="MainTabs" component={MainTabs} />
          <RootStack.Screen
            name="Chat"
            component={ChatScreen}
            options={({ route }) => headerOptions(route.params.friend.username)}
          />
          <RootStack.Screen
            name="PhotoPreview"
            component={PhotoPreviewScreen}
            // No animation, so the captured frame seems to freeze in place.
            options={{ presentation: 'fullScreenModal', animation: 'none' }}
          />
          <RootStack.Screen
            name="RecipientPicker"
            component={RecipientPicker}
            options={{ presentation: 'fullScreenModal' }}
          />
          <RootStack.Screen
            name="StoryViewer"
            component={StoryViewer}
            options={{ presentation: 'fullScreenModal', animation: 'fade' }}
          />
          <RootStack.Screen
            name="Profile"
            component={ProfileScreen}
            options={headerOptions('Profile')}
          />
          <RootStack.Screen
            name="AddFriend"
            component={AddFriendScreen}
            options={headerOptions('Add friend')}
          />
          <RootStack.Screen
            name="ScanFriend"
            component={ScanFriendScreen}
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          />
          <RootStack.Screen
            name="Devices"
            component={DevicesScreen}
            options={headerOptions('Devices')}
          />
          <RootStack.Screen
            name="ScanLink"
            component={ScanLinkScreen}
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          />
        </>
      )}
    </RootStack.Navigator>
  );
}

const tabStyles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    flexDirection: 'row',
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: { flex: 1, alignItems: 'center' },
});

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg },
});
