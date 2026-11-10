import React from 'react';
import {
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, type TextInputProps,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUi2Theme } from '../store';
import { FONT } from '../font';

// claude: a pushed screen in the board's language: the secondary color behind a back button and title, then the
// white sheet. The pills and labels below are the board's .option, .editor-input and .editor-label.
export function Page({ title, children }: { title: string; children: React.ReactNode }) {
  const nav = useNavigation();
  const theme = useUi2Theme();
  const on = theme.onSecondary;
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { backgroundColor: theme.sky, paddingTop: insets.top }]}>
      <View style={styles.head}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => nav.goBack()} accessibilityLabel="Back">
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
            <Path d="M15 5l-7 7 7 7" stroke={on.ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </TouchableOpacity>
        <Text style={[styles.title, { color: on.ink }]} numberOfLines={1}>{title}</Text>
      </View>
      <ScrollView
        style={[styles.sheet, { backgroundColor: theme.paper }]}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function SectionLabel({ children }: { children: string }) {
  const theme = useUi2Theme();
  return <Text style={[styles.label, { color: theme.muted }]}>{children}</Text>;
}

export function Hint({ children, danger = false }: { children: string; danger?: boolean }) {
  const theme = useUi2Theme();
  return <Text style={[styles.hint, { color: danger ? theme.alert : theme.muted }]}>{children}</Text>;
}

interface PillButtonProps {
  label: string;
  onPress: () => void;
  tone?: 'sun' | 'plain' | 'danger';
  disabled?: boolean;
}

export function PillButton({ label, onPress, tone = 'sun', disabled = false }: PillButtonProps) {
  const theme = useUi2Theme();
  const sun = tone === 'sun';
  return (
    <TouchableOpacity
      style={[styles.button, { backgroundColor: sun ? theme.sun : theme.paper, borderColor: theme.outline }, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.buttonText, { color: sun ? theme.sunInk : tone === 'danger' ? theme.alert : theme.ink }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function PillInput(props: TextInputProps) {
  const theme = useUi2Theme();
  return (
    <TextInput
      placeholderTextColor={theme.muted}
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={[styles.input, { color: theme.ink, backgroundColor: theme.paper, borderColor: theme.outline }]}
    />
  );
}

// claude: a label on the left and whatever belongs on the right, as one pill.
export function InfoRow({ label, children }: { label: string; children?: React.ReactNode }) {
  const theme = useUi2Theme();
  return (
    <View style={[styles.row, { backgroundColor: theme.paper, borderColor: theme.outline }]}>
      <Text style={[styles.rowLabel, { color: theme.ink }]} numberOfLines={1}>{label}</Text>
      {children}
    </View>
  );
}

export function Note({ children }: { children: string }) {
  const theme = useUi2Theme();
  return <Text style={[styles.note, { color: theme.muted }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingBottom: 12 },
  iconBtn: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 17, fontFamily: FONT[900] },
  sheet: { flex: 1, borderTopLeftRadius: 26, borderTopRightRadius: 26 },
  content: { flexGrow: 1, padding: 16, gap: 8 },
  label: { fontSize: 13, fontFamily: FONT[900], marginTop: 6 },
  hint: { fontSize: 13, fontFamily: FONT[700], lineHeight: 17.5 },
  button: {
    minHeight: 40, paddingHorizontal: 16, borderRadius: 999, borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: 13, fontFamily: FONT[900] },
  input: { flex: 1, fontSize: 13, fontFamily: FONT[700], borderWidth: 2, borderRadius: 999, height: 40, paddingHorizontal: 14, paddingVertical: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingHorizontal: 16, borderWidth: 2, borderRadius: 999 },
  rowLabel: { flex: 1, fontSize: 14, fontFamily: FONT[800] },
  note: { fontSize: 12, fontFamily: FONT[800] },
});
