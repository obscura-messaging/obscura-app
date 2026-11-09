import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

// claude: the board's avatar colors (its chat list). Profile color is pending in the data, so one is picked from
// the username until it lands.
const AVATAR_COLORS = [
  '#FFB23F', '#7ED957', '#FFD21A', '#B79CF2', '#62C6F3', '#FFE07A', '#FF8FB1', '#9FE3C4',
  '#FF9F6B', '#A7D8FF', '#D7E3FF', '#FFC2D9', '#B8F0A6', '#E8D4FF', '#FFB3A7',
];

export function avatarColor(username: string): string {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 2147483647;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

interface AvatarProps {
  name: string;
  size: number;
  radius: number;
  outline: string;
  ink: string;
  background?: string;
  // claude: your own avatar's character, from the ui2 store
  emoji?: string | null;
  // claude: the board's photo-chat avatar: a bigger letter, shifted and cropped
  cropped?: boolean;
}

// claude: a letter stands in for the profile emoji, which the data does not have yet.
export function Avatar({ name, size, radius, outline, ink, background, emoji, cropped }: AvatarProps) {
  const k = size / 48;
  const fontSize = cropped ? 38 * k : 28 * k;
  return (
    <View
      style={[
        styles.box,
        {
          width: size, height: size, borderRadius: radius,
          backgroundColor: background ?? avatarColor(name),
          borderColor: outline, boxShadow: `0 3px 0 ${outline}`,
        },
      ]}
    >
      <Text
        style={[
          styles.letter,
          { color: ink, fontSize, lineHeight: fontSize * 1.15 },
          cropped && { transform: [{ translateX: -10 * k }, { translateY: 4 * k }] },
        ]}
      >
        {emoji ?? name[0]?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 2.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { fontWeight: '900', includeFontPadding: false },
});
