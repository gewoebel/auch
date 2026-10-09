/**
 * Firebase-Konfiguration
 * 1. In der Firebase Console eine Web-App registrieren.
 * 2. Das angezeigte firebaseConfig-Objekt hier eintragen.
 * 3. Die Anführungszeichen beibehalten.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBnBpingnWkqRPdKu_bCU00sztPKIqashk",
  databaseURL: "https://auch-spiel-default-rtdb.europe-west1.firebasedatabase.app",
  authDomain: "auch-spiel.firebaseapp.com",
  projectId: "auch-spiel",
  storageBucket: "auch-spiel.firebasestorage.app",
  messagingSenderId: "1049500351882",
  appId: "1:1049500351882:web:60ab3fffe25cf624b59c73"

};

export const firebaseIsConfigured = !Object.values(firebaseConfig).some(
  (value) => typeof value !== "string" || value.includes("HIER_EINTRAGEN")
);
