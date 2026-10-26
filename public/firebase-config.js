// Firebase web uygulaması ayarları (firebase apps:sdkconfig ile alındı).
// Bu değerler gizli değildir; erişimi firestore.rules korur. Kendi kopyanı kurarken
// buraya kendi projenin ayarlarını yapıştır (bkz. README).
// localhost'ta açıldığında firebase.js bunun yerine emülatöre bağlanır.
export const firebaseConfig = {
  apiKey: "AIzaSyBJ9EB4ahVeOVNFdzLswwNvlAttBYEnHUI",
  authDomain: "kervan-7c9f64.firebaseapp.com",
  projectId: "kervan-7c9f64",
  storageBucket: "kervan-7c9f64.firebasestorage.app",
  messagingSenderId: "741291354514",
  appId: "1:741291354514:web:d109c591b408ed52fcb94b",
};

// Anahtarsız fatura okuma (Firebase AI Logic) için App Check'in Fraud Defense
// (reCAPTCHA Enterprise) site anahtarı. Gizli değildir. Boşsa anahtarsız yol kapalıdır.
export const recaptchaSiteKey = "6LepSQEuAAAAAEhIg38ANwDCZJRnoWZkqM39V4_F";
