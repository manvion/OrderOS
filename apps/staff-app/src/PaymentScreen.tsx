import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { useStripeTerminal, type Reader } from '@stripe/stripe-terminal-react-native';
import { createTerminalIntent, settleTerminalOrder } from './lib/api';

/**
 * The one screen that matters: connect Tap to Pay on this phone, then charge an order.
 *
 * The charge is a five-step Terminal dance, and every step is verified by Stripe, not by
 * us trusting the device:
 *   1. our API creates the card-present PaymentIntent for the order   → clientSecret
 *   2. retrievePaymentIntent(clientSecret)                            → local intent
 *   3. collectPaymentMethod  (this is the actual customer tap)
 *   4. confirmPaymentIntent   (captures the money)
 *   5. our API's /settle re-reads the intent from Stripe and marks the order paid
 *
 * Step 5 is what flips the order to PAID and reads the real processing fee — the app
 * never marks anything paid on its own say-so.
 */
export function PaymentScreen() {
  const {
    initialize,
    discoverReaders,
    connectReader,
    discoveredReaders,
    connectedReader,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
  } = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      // The phone itself is the reader for Tap to Pay — connect to the first one found.
      if (!connectedReader && readers.length > 0) void connect(readers[0]);
    },
  });

  const [status, setStatus] = useState('Starting…');
  const [busy, setBusy] = useState(false);
  const [orderId, setOrderId] = useState('');

  // Boot: location permission (Stripe requires it for in-person), init, discover Tap to Pay.
  useEffect(() => {
    (async () => {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        setStatus('Location permission is required to accept card payments.');
        return;
      }
      await initialize();
      setStatus('Looking for Tap to Pay…');
      const { error } = await discoverReaders({ discoveryMethod: 'tapToPay' });
      if (error) setStatus(`Could not start Tap to Pay: ${error.message}`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(reader: Reader.Type) {
    const { error } = await connectReader({ reader }, 'tapToPay');
    setStatus(error ? `Connect failed: ${error.message}` : 'Ready to charge');
  }

  async function charge() {
    if (!orderId.trim()) return;
    setBusy(true);
    try {
      setStatus('Creating charge…');
      const { clientSecret } = await createTerminalIntent(orderId.trim());

      const { paymentIntent, error: retrErr } = await retrievePaymentIntent(clientSecret);
      if (retrErr || !paymentIntent) throw new Error(retrErr?.message ?? 'Could not load the charge');

      setStatus('Tap the card…');
      const { error: collectErr } = await collectPaymentMethod({ paymentIntent });
      if (collectErr) throw new Error(collectErr.message);

      setStatus('Confirming…');
      const { error: confirmErr } = await confirmPaymentIntent({ paymentIntent });
      if (confirmErr) throw new Error(confirmErr.message);

      await settleTerminalOrder(orderId.trim());
      setStatus('Paid ✓');
      Alert.alert('Payment complete', `Order ${orderId.trim()} is paid.`);
      setOrderId('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Payment failed';
      setStatus(message);
      Alert.alert('Payment failed', message);
    } finally {
      setBusy(false);
    }
  }

  const ready = !!connectedReader;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>Take payment</Text>
        <Text style={styles.status}>{status}</Text>

        <TextInput
          style={styles.input}
          placeholder="Order ID"
          autoCapitalize="none"
          value={orderId}
          onChangeText={setOrderId}
          editable={ready && !busy}
        />

        {busy ? (
          <ActivityIndicator style={{ marginTop: 16 }} />
        ) : (
          <View style={{ marginTop: 12 }}>
            <Button title="Charge with Tap to Pay" onPress={charge} disabled={!ready || !orderId.trim()} />
          </View>
        )}

        {!ready && !!discoveredReaders.length && (
          <Text style={styles.hint}>Connecting the reader…</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0b0f', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#17171d', borderRadius: 20, padding: 24 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 6 },
  status: { color: '#9aa0aa', fontSize: 14, marginBottom: 16 },
  input: {
    backgroundColor: '#0b0b0f',
    borderColor: '#2a2a33',
    borderWidth: 1,
    borderRadius: 12,
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hint: { color: '#9aa0aa', fontSize: 12, marginTop: 12, textAlign: 'center' },
});
