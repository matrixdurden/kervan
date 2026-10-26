import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Bilgisayarda yerel test ederken gerçek veritabanı yerine emülatörü kullan.
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

export const app = initializeApp(isLocal ? { ...firebaseConfig, apiKey: "demo-key", authDomain: "demo-kervan.firebaseapp.com", projectId: "demo-kervan" } : firebaseConfig);
export { isLocal };

export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

if (isLocal) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
}
