import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useStripeTerminal } from '@stripe/stripe-terminal-react-native';
import { createTerminalIntent, settleTerminalOrder, type AwaitingOrder } from './lib/api';
import { theme } from './theme';

function money(cents: number, currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
}

type Phase = 'starting' | 'tap' | 'confirming' | 'done' | 'error';

/**
 * The charge itself — the five-step Terminal dance for one order, run when staff pick it:
 *   1. our API creates the card-present PaymentIntent            → clientSecret
 *   2. retrievePaymentIntent(clientSecret)
 *   3. collectPaymentMethod   (the customer taps their card)
 *   4. confirmPaymentIntent    (captures)
 *   5. our API /settle re-reads the intent and marks the order paid
 *
 * The app never marks anything paid itself — step 5 trusts Stripe, not the device.
 */
export function ChargeSheet({
  order,
  onClose,
  onPaid,
}: {
  order: AwaitingOrder;
  onClose: () => void;
  onPaid: () => void;
}) {
  const { retrievePaymentIntent, collectPaymentMethod, confirmPaymentIntent } = useStripeTerminal();
  const [phase, setPhase] = useState<Phase>('starting');
  const [message, setMessage] = useState('Preparing the charge…');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { clientSecret } = await createTerminalIntent(order.id);
        if (cancelled) return;

        const { paymentIntent, error: retrErr } = await retrievePaymentIntent(clientSecret);
        if (retrErr || !paymentIntent) throw new Error(retrErr?.message ?? 'Could not load the charge');

        setPhase('tap');
        setMessage('Ask the customer to tap their card.');
        const { error: collectErr } = await collectPaymentMethod({ paymentIntent });
        if (collectErr) throw new Error(collectErr.message);

        setPhase('confirming');
        setMessage('Confirming…');
        const { error: confirmErr } = await confirmPaymentIntent({ paymentIntent });
        if (confirmErr) throw new Error(confirmErr.message);

        await settleTerminalOrder(order.id);
        if (cancelled) return;
        setPhase('done');
        setMessage('Paid');
        setTimeout(onPaid, 1200);
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setMessage(err instanceof Error ? err.message : 'Payment failed');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  const spinning = phase === 'starting' || phase === 'tap' || phase === 'confirming';

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.amount}>{money(order.totalCents, order.currency)}</Text>
          <Text style={styles.order}>
            Order #{order.orderNumber.slice(-3)}
            {order.tableNumber ? ` · Table ${order.tableNumber}` : ''}
          </Text>

          <View style={styles.body}>
            {spinning && <ActivityIndicator size="large" color={theme.brand} />}
            {phase === 'done' && <Text style={styles.done}>✓</Text>}
            {phase === 'error' && <Text style={styles.errorMark}>!</Text>}
            <Text style={[styles.message, phase === 'error' && styles.messageError]}>{message}</Text>
          </View>

          {(phase === 'error' || phase === 'tap' || phase === 'starting') && (
            <TouchableOpacity style={styles.cancel} onPress={onClose}>
              <Text style={styles.cancelText}>{phase === 'error' ? 'Close' : 'Cancel'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 28,
    paddingBottom: 40,
    alignItems: 'center',
  },
  amount: { color: theme.text, fontSize: 40, fontWeight: '800' },
  order: { color: theme.muted, fontSize: 14, marginTop: 4 },
  body: { alignItems: 'center', gap: 14, marginVertical: 32, minHeight: 90, justifyContent: 'center' },
  done: { color: '#34d399', fontSize: 44, fontWeight: '800' },
  errorMark: { color: '#f87171', fontSize: 44, fontWeight: '800' },
  message: { color: theme.text, fontSize: 16, textAlign: 'center' },
  messageError: { color: '#f87171' },
  cancel: { paddingVertical: 12, paddingHorizontal: 24 },
  cancelText: { color: theme.muted, fontSize: 15 },
});
