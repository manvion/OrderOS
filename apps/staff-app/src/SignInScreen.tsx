import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSignIn } from '@clerk/clerk-expo';
import { theme } from './theme';

/**
 * Staff sign-in — the same DineDirect account they use on the web dashboard.
 * Email + password via Clerk; on success Clerk stores the session (secure store) and the
 * app flips to the POS.
 */
export function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signIn.create({ identifier: email.trim(), password });
      if (res.status === 'complete') {
        await setActive({ session: res.createdSessionId });
      } else {
        // e.g. MFA — out of scope for this scaffold; surface it rather than hang.
        setError('Additional verification is required. Sign in on the web dashboard first.');
      }
    } catch (err: unknown) {
      const message =
        (err as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ??
        'Could not sign in. Check your email and password.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.brand}>DineDirect</Text>
        <Text style={styles.title}>Staff sign-in</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          editable={!busy}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={theme.muted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          editable={!busy}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, (busy || !email || !password) && styles.buttonDisabled]}
          onPress={submit}
          disabled={busy || !email || !password}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </TouchableOpacity>

        <Text style={styles.hint}>
          Use the same account as the web dashboard. Only staff of your restaurant can sign in.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: theme.card, borderRadius: 20, padding: 24 },
  brand: { color: theme.text, fontSize: 14, fontWeight: '700', letterSpacing: 2, marginBottom: 4 },
  title: { color: theme.text, fontSize: 24, fontWeight: '800', marginBottom: 20 },
  input: {
    backgroundColor: theme.bg,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 12,
    color: theme.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  error: { color: '#f87171', fontSize: 13, marginBottom: 12 },
  button: {
    backgroundColor: theme.brand,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  hint: { color: theme.muted, fontSize: 12, marginTop: 16, textAlign: 'center' },
});
