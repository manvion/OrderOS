import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { useAuth } from '@clerk/clerk-expo';
import { useStripeTerminal, type Reader } from '@stripe/stripe-terminal-react-native';
import { fetchAwaitingPayment, type AwaitingOrder } from './lib/api';
import { ChargeSheet } from './ChargeSheet';
import { theme } from './theme';

function money(cents: number, currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
}

/**
 * The signed-in POS: connect Tap to Pay once, then let staff pick an unpaid order and
 * charge it. Reader connection lives here (not per-charge) so it stays up across payments.
 */
export function PosApp() {
  const { signOut } = useAuth();
  const {
    initialize,
    discoverReaders,
    connectReader,
    connectedReader,
  } = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      if (!connectedReader && readers.length > 0) void connect(readers[0]);
    },
  });

  const [readerStatus, setReaderStatus] = useState('Starting…');
  const [orders, setOrders] = useState<AwaitingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AwaitingOrder | null>(null);

  // Boot Tap to Pay: location permission (Stripe requires it), init, discover.
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setReaderStatus('Location permission is required to accept card payments.');
        return;
      }
      await initialize();
      setReaderStatus('Connecting Tap to Pay…');
      const { error } = await discoverReaders({ discoveryMethod: 'tapToPay' });
      if (error) setReaderStatus(`Tap to Pay unavailable: ${error.message}`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(reader: Reader.Type) {
    const { error } = await connectReader({ reader }, 'tapToPay');
    setReaderStatus(error ? `Reader error: ${error.message}` : 'Ready');
  }

  const load = useCallback(async () => {
    try {
      setOrders(await fetchAwaitingPayment());
    } catch {
      // leave the last list on screen; a transient failure shouldn't blank it
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const ready = !!connectedReader;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Take payment</Text>
          <Text style={[styles.status, ready && styles.statusReady]}>
            {ready ? 'Tap to Pay ready' : readerStatus}
          </Text>
        </View>
        <TouchableOpacity onPress={() => signOut()}>
          <Text style={styles.signout}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.brand} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={theme.muted} />}
          ListEmptyComponent={<Text style={styles.empty}>No orders waiting to be paid.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.order, !ready && styles.orderDisabled]}
              disabled={!ready}
              onPress={() => setSelected(item)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.orderTitle}>
                  #{item.orderNumber.slice(-3)}
                  {item.tableNumber ? ` · Table ${item.tableNumber}` : ''}
                </Text>
                <Text style={styles.orderSub} numberOfLines={1}>
                  {item.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                </Text>
              </View>
              <Text style={styles.orderTotal}>{money(item.totalCents, item.currency)}</Text>
            </TouchableOpacity>
          )}
        />
      )}

      {selected && (
        <ChargeSheet
          order={selected}
          onClose={() => setSelected(null)}
          onPaid={() => {
            setSelected(null);
            void load();
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomColor: theme.border,
    borderBottomWidth: 1,
  },
  title: { color: theme.text, fontSize: 20, fontWeight: '800' },
  status: { color: theme.muted, fontSize: 13, marginTop: 2 },
  statusReady: { color: '#34d399' },
  signout: { color: theme.muted, fontSize: 14 },
  empty: { color: theme.muted, textAlign: 'center', marginTop: 40 },
  order: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderRadius: 14,
    padding: 16,
  },
  orderDisabled: { opacity: 0.5 },
  orderTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  orderSub: { color: theme.muted, fontSize: 13, marginTop: 2 },
  orderTotal: { color: theme.text, fontSize: 16, fontWeight: '800' },
});
