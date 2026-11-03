import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

export const C = {
  bg: '#F1F5F9',
  card: '#FFFFFF',
  border: '#E2E8F0',
  text: '#0F172A',
  muted: '#64748B',
  primary: '#2563EB',
  primaryDark: '#1E3A8A',
  header: '#0F172A',
  ok: '#16A34A',
  okBg: '#DCFCE7',
  warn: '#D97706',
  warnBg: '#FEF3C7',
  err: '#DC2626',
  errBg: '#FEE2E2',
  infoBg: '#DBEAFE',
  term: '#0B1220',
  termText: '#A7F3D0',
};

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Consolas, monospace' });

export function Screen({
  children,
  refreshing,
  onRefresh,
}: {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={s.screen}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      <View style={s.inner}>{children}</View>
    </ScrollView>
  );
}

export function Card({ children, style, title, right }: { children?: React.ReactNode; style?: StyleProp<ViewStyle>; title?: string; right?: React.ReactNode }) {
  return (
    <View style={[s.card, style]}>
      {(title || right) && (
        <View style={s.cardHead}>
          {title ? <Text style={s.cardTitle}>{title}</Text> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Row({ label, value, monoValue }: { label: string; value: React.ReactNode; monoValue?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' || value == null ? (
        <Text style={[s.rowValue, monoValue && { fontFamily: mono }]} selectable>
          {value == null || value === '' ? '—' : value}
        </Text>
      ) : (
        <View style={{ flex: 1 }}>{value}</View>
      )}
    </View>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  icon,
  small,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  icon?: string;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const bg = { primary: C.primary, secondary: '#E2E8F0', danger: C.err, ghost: 'transparent', success: C.ok }[variant];
  const fg = variant === 'secondary' || variant === 'ghost' ? C.text : '#fff';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.btn,
        small && s.btnSmall,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: C.border },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : null}
      <Text style={[s.btnText, small && { fontSize: 13 }, { color: fg }]}>
        {icon ? `${icon}  ` : ''}
        {title}
      </Text>
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ marginBottom: 10, flexGrow: 1, flexBasis: 140 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor="#94A3B8" autoCapitalize="none" autoCorrect={false} {...props} style={[s.input, props.multiline && { minHeight: 80, textAlignVertical: 'top' }, props.style]} />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, selected && { backgroundColor: C.primary, borderColor: C.primary }]}>
      <Text style={[s.chipText, selected && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ text, tone = 'info' }: { text: string; tone?: 'ok' | 'warn' | 'err' | 'info' | 'muted' }) {
  const map = {
    ok: [C.okBg, C.ok],
    warn: [C.warnBg, C.warn],
    err: [C.errBg, C.err],
    info: [C.infoBg, C.primaryDark],
    muted: ['#E2E8F0', C.muted],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <Text style={[s.badgeText, { color: fg }]}>{text}</Text>
    </View>
  );
}

export function Terminal({ text, maxHeight = 360 }: { text: string; maxHeight?: number }) {
  return (
    <ScrollView style={[s.term, { maxHeight }]} nestedScrollEnabled horizontal={false}>
      <Text selectable style={s.termText}>
        {text}
      </Text>
    </ScrollView>
  );
}

export function Notice({ text, tone = 'info' }: { text: string; tone?: 'ok' | 'warn' | 'err' | 'info' }) {
  const bg = { ok: C.okBg, warn: C.warnBg, err: C.errBg, info: C.infoBg }[tone];
  const fg = { ok: '#14532D', warn: '#78350F', err: '#7F1D1D', info: C.primaryDark }[tone];
  return (
    <View style={[s.notice, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 13, lineHeight: 18 }}>{text}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={s.empty}>{text}</Text>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={s.segment}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.segItem, value === o.value && s.segActive]}>
          <Text style={[s.segText, value === o.value && { color: C.text, fontWeight: '700' }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export const H = ({ children }: { children: React.ReactNode }) => <Text style={s.h}>{children}</Text>;
export const Muted = ({ children, style }: { children: React.ReactNode; style?: object }) => <Text style={[s.muted, style]}>{children}</Text>;
export const Wrap = ({ children, gap = 8 }: { children: React.ReactNode; gap?: number }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, alignItems: 'center' }}>{children}</View>
);

export const s = StyleSheet.create({
  screen: { padding: 14, paddingBottom: 48 },
  inner: { width: '100%', maxWidth: 860, alignSelf: 'center', gap: 12 },
  card: { backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, gap: 8 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: C.text },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 3 },
  rowLabel: { width: 120, color: C.muted, fontSize: 13 },
  rowValue: { flex: 1, color: C.text, fontSize: 13 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 16, borderRadius: 9 },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 11 },
  btnText: { fontWeight: '700', fontSize: 14 },
  label: { fontSize: 12, color: C.muted, marginBottom: 4, fontWeight: '600' },
  hint: { fontSize: 11, color: C.muted, marginTop: 3 },
  input: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14, color: C.text, backgroundColor: '#fff' },
  chip: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 99, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#fff' },
  chipText: { fontSize: 13, color: C.text },
  badge: { borderRadius: 99, paddingVertical: 2, paddingHorizontal: 8, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '700' },
  term: { backgroundColor: C.term, borderRadius: 8, padding: 10 },
  termText: { color: C.termText, fontFamily: mono, fontSize: 12, lineHeight: 17 },
  notice: { borderRadius: 8, padding: 10 },
  empty: { color: C.muted, textAlign: 'center', paddingVertical: 18 },
  segment: { flexDirection: 'row', backgroundColor: '#E2E8F0', borderRadius: 9, padding: 3 },
  segItem: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 7 },
  segActive: { backgroundColor: '#fff' },
  segText: { color: C.muted, fontSize: 13 },
  h: { fontSize: 13, fontWeight: '800', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4 },
  muted: { color: C.muted, fontSize: 12 },
});
