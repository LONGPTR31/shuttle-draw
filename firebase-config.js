// Firebase 連線設定。這些值本來就會出現在公開網頁裡，不是機密。
export const firebaseConfig = {
  apiKey: "AIzaSyA2jYMCZywP2jv28JTPAneXO2ZDZczV9FQ",
  authDomain: "shuttle-draw.firebaseapp.com",
  projectId: "shuttle-draw",
  storageBucket: "shuttle-draw.firebasestorage.app",
  messagingSenderId: "453153281443",
  appId: "1:453153281443:web:585b7cd3c12b981f2bb616"
};

// 管理員登入用的內部帳號。管理員在網頁上只輸入密碼。
// 必須和 Firebase 後台 Authentication 裡建立的帳號 email 完全相同。
export const adminEmail = "admin@shuttle-draw.example.com";
