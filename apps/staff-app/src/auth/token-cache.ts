import * as SecureStore from 'expo-secure-store';
import type { TokenCache } from '@clerk/clerk-expo';

/**
 * Where Clerk keeps the session on-device. expo-secure-store is the OS keychain
 * (Keychain on iOS, Keystore on Android), so the staff session survives app restarts
 * without ever sitting in plain storage.
 */
export const tokenCache: TokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // best-effort; a keychain write failure just means they sign in again next launch
    }
  },
};
