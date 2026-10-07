/**
 * Seals each account's e-mails with AES-GCM under a PBKDF2 key derived from
 * its login, so the published files reveal neither the logins nor the mail.
 * ComputerScreenLogin.ProcessLogin compares Caps(name) and Caps(password),
 * so both are uppercased here too. Used by the build (Node) and the page
 * (browser); both provide WebCrypto.
 */
const ITERATIONS = 150000;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function deriveKey(user, password, salt) {
  const secret = encoder.encode(`${user.toUpperCase()}\n${password.toUpperCase()}`);
  const base = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS},
    base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

/** [{user, password, ...payload}] → sealed records, in a shuffled order. */
export async function encryptStory(accounts) {
  const records = [];
  for (const {password, ...payload} of accounts) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(payload.user, password, salt);
    const data = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, encoder.encode(JSON.stringify(payload))));
    records.push({salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data)});
  }
  for (let i = records.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [records[i], records[j]] = [records[j], records[i]];
  }
  return records;
}

/** The account a login opens, or null. */
export async function openAccount(records, user, password) {
  for (const record of records) {
    try {
      const key = await deriveKey(user, password, fromBase64(record.salt));
      const data = await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromBase64(record.iv)}, key, fromBase64(record.data));
      return JSON.parse(decoder.decode(data));
    } catch {
      // Wrong login for this record: GCM authentication fails.
    }
  }
  return null;
}
