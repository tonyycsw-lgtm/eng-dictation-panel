// firebase-config.js
// 英語默書系統 - Firebase 設定檔

// Firebase 模組導入（使用最新版本 12.10.0）
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { 
    getAuth, 
    GoogleAuthProvider, 
    signInWithPopup, 
    signOut, 
    onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    deleteDoc, 
    collection, 
    query, 
    where, 
    getDocs, 
    increment,
    orderBy,
    limit,
    startAfter,
    getCountFromServer
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// 英語系統的 Firebase 專案設定
const firebaseConfig = {
    apiKey: "AIzaSyABfaBvx5ovgYDGfCMyparh8JjqVtIRr8M",
    authDomain: "eng-dictation-panel.firebaseapp.com",
    projectId: "eng-dictation-panel",
    storageBucket: "eng-dictation-panel.firebasestorage.app",
    messagingSenderId: "428851908520",
    appId: "1:428851908520:web:9ce49c5034ed1d193fd79d"
};

// 初始化 Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// 匯出供其他模組使用
export { 
    auth, 
    db, 
    googleProvider, 
    signInWithPopup, 
    signOut, 
    onAuthStateChanged,
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    deleteDoc,
    increment,
    orderBy,
    limit,
    startAfter,
    getCountFromServer
};