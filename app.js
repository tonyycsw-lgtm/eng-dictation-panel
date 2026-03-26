// === 導入 Firebase 模組 ===
import { auth, db, doc, getDoc, setDoc, updateDoc, increment, signOut, onAuthStateChanged, collection, getDocs, query, orderBy, limit, where, addDoc, arrayUnion } from './firebase-config.js';

// === 應用配置 ===
const CONFIG = {
    DATA_PATH: 'data/',
    UNITS_INDEX: 'units-index.json',
    DEFAULT_UNIT: 'unit1'
};

// === 全局變量 ===
let appData = null;
let unitsIndex = { units: [] };
let currentUnitId = '';
let starData = {};
let learningStats = {};
let defaultStars = {};

// 用戶狀態
let currentUser = null;
let currentUserRole = 'user';
let currentUserBranch = [];      // 改為陣列
let isGuestMode = false;
let lastSyncTime = null;

// 訪客模式專用
let guestGrade = 'P2';
let guestPublisher = '示範';
const GUEST_GRADES = ['P2', 'P5', 'S1'];

// 通知相關變量
let notifications = [];
let unreadCount = 0;

// 輔助函數：檢查兩個陣列是否有交集
function hasIntersection(arr1, arr2) {
    if (!arr1 || !arr2) return false;
    if (arr1.length === 0 || arr2.length === 0) return false;
    return arr1.some(item => arr2.includes(item));
}

// === 改良的音頻播放器 ===
class StableAudioPlayer {
    constructor() {
        this.currentAudioBtn = null;
        this.currentUtterance = null;
        this.isPlaying = false;
        this.isStopping = false;
        this.warmUpTTS();
    }
    
    warmUpTTS() {
        if ('speechSynthesis' in window) {
            try {
                const utterance = new SpeechSynthesisUtterance('');
                utterance.volume = 0;
                speechSynthesis.speak(utterance);
                setTimeout(() => speechSynthesis.cancel(), 100);
            } catch (e) {}
        }
    }
    
    stopCurrentAudio() {
        this.isStopping = true;
        this.isPlaying = false;
        if (speechSynthesis && speechSynthesis.speaking) {
            speechSynthesis.cancel();
        }
        this.currentUtterance = null;
        if (this.currentAudioBtn) {
            this.currentAudioBtn.classList.remove('playing');
            this.currentAudioBtn.classList.remove('disabled');
            this.currentAudioBtn.disabled = false;
            this.currentAudioBtn = null;
        }
        this.isStopping = false;
    }
    
    async playAudio(audioKey, btn, event) {
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }
        if (this.isStopping) return;
        if (this.currentAudioBtn === btn && this.isPlaying) {
            this.stopCurrentAudio();
            return;
        }
        if (this.isPlaying && this.currentAudioBtn !== btn) {
            this.stopCurrentAudio();
            await this.sleep(100);
        }
        const text = this.getTextForAudioKey(audioKey);
        try {
            await this.playBrowserTTS(text, btn);
        } catch (error) {
            console.error('音頻播放失敗:', error);
            this.resetButtonState(btn);
        }
    }
    
    getTextForAudioKey(audioKey) {
        if (!appData) return audioKey;
        const word = appData.words.find(w => w.audio === audioKey);
        if (word) return word.english;
        const sentence = appData.sentences.find(s => s.audio === audioKey);
        return sentence ? sentence.english : audioKey;
    }
    
    playBrowserTTS(text, btn) {
        return new Promise((resolve, reject) => {
            if (!('speechSynthesis' in window)) {
                reject(new Error('不支持語音合成'));
                return;
            }
            if (speechSynthesis.speaking) speechSynthesis.cancel();
            this.currentUtterance = new SpeechSynthesisUtterance(text);
            this.currentUtterance.lang = 'en-GB';
            this.currentUtterance.rate = 0.85;
            this.currentAudioBtn = btn;
            this.isPlaying = true;
            btn.classList.add('playing', 'disabled');
            btn.disabled = true;
            this.currentUtterance.onstart = () => resolve();
            this.currentUtterance.onerror = (event) => {
                this.isPlaying = false;
                this.resetButtonState(btn);
                this.currentUtterance = null;
                this.currentAudioBtn = null;
                reject(event);
            };
            this.currentUtterance.onend = () => {
                this.isPlaying = false;
                this.resetButtonState(btn);
                this.currentUtterance = null;
                this.currentAudioBtn = null;
                resolve();
            };
            setTimeout(() => speechSynthesis.speak(this.currentUtterance), 50);
        });
    }
    
    resetButtonState(btn) {
        if (btn) {
            btn.classList.remove('playing', 'disabled');
            btn.disabled = false;
        }
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const audioPlayer = new StableAudioPlayer();

// === Toast 提示 ===
function showToast(message, type = 'error') {
    const existing = document.querySelector('.toast-message');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = 'toast-message';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 20px;
        border-radius: 8px;
        color: white;
        background: ${type === 'success' ? '#10b981' : '#ef4444'};
        z-index: 10001;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: fadeInOut 3s ease forwards;
        pointer-events: none;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// === 輔助函數 ===
function stopPropagation(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
}

function formatDate(dateString) {
    if (!dateString) return '從未';
    return new Date(dateString).toLocaleDateString('zh-HK');
}

function formatTime(minutes) {
    if (minutes < 60) return `${minutes} 分鐘`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} 小時 ${mins} 分鐘` : `${hours} 小時`;
}

function formatRelativeTime(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffMinutes = Math.floor((now - date) / (1000 * 60));
    
    if (diffMinutes < 1) return '剛剛';
    if (diffMinutes < 60) return `${diffMinutes}分鐘前`;
    if (diffMinutes < 1440) return `${Math.floor(diffMinutes / 60)}小時前`;
    if (diffMinutes < 10080) return `${Math.floor(diffMinutes / 1440)}天前`;
    return `${Math.floor(diffMinutes / 10080)}週前`;
}

// === 訪客模式函數 ===
function isGuestModeActive() {
    return localStorage.getItem('guestMode') === 'true';
}

function getGuestGrade() {
    return localStorage.getItem('guestGrade') || 'P2';
}

function setGuestGrade(grade) {
    localStorage.setItem('guestGrade', grade);
    guestGrade = grade;
}

// === 通知相關函數 ===
async function loadNotifications() {
    if (!currentUser || isGuestMode) return;
    
    try {
        const notificationsRef = collection(db, 'notifications');
        const q = query(
            notificationsRef,
            orderBy('createdAt', 'desc'),
            limit(50)
        );
        const snapshot = await getDocs(q);
        
        notifications = [];
        snapshot.forEach(doc => {
            const notif = doc.data();
            const isTargeted = isNotificationForUser(notif);
            if (isTargeted) {
                notifications.push({
                    id: doc.id,
                    ...notif,
                    isRead: notif.isReadBy?.includes(currentUser.uid) || false
                });
            }
        });
        
        unreadCount = notifications.filter(n => !n.isRead).length;
        updateNotificationBadge();
        renderNotificationList();
        
    } catch (error) {
        console.error('載入通知失敗:', error);
    }
}

function isNotificationForUser(notif) {
    const target = notif.targetUsers;
    
    if (!target || (Array.isArray(target) && target.length === 0) || target.type === undefined) {
        return true;
    }
    
    if (target.type === 'branch') {
        const userBranchArray = Array.isArray(currentUserBranch) ? currentUserBranch : (currentUserBranch ? [currentUserBranch] : []);
        return userBranchArray.includes(target.value);
    }
    
    if (target.type === 'selected') {
        return target.value.includes(currentUser.uid);
    }
    
    return true;
}

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    if (badge) {
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

async function markNotificationAsRead(notificationId) {
    try {
        const notifRef = doc(db, 'notifications', notificationId);
        await updateDoc(notifRef, {
            isReadBy: arrayUnion(currentUser.uid)
        });
        
        const notif = notifications.find(n => n.id === notificationId);
        if (notif) {
            notif.isRead = true;
            unreadCount--;
            updateNotificationBadge();
            renderNotificationList();
        }
    } catch (error) {
        console.error('標記已讀失敗:', error);
    }
}

async function markAllNotificationsAsRead() {
    const unreadNotifs = notifications.filter(n => !n.isRead);
    for (const notif of unreadNotifs) {
        await markNotificationAsRead(notif.id);
    }
}

function renderNotificationList() {
    const container = document.getElementById('notificationList');
    if (!container) return;
    
    if (notifications.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #94a3b8;">暫無通知</div>';
        return;
    }
    
    container.innerHTML = notifications.map(notif => `
        <div class="notification-item" onclick="openNotificationDetail('${notif.id}')"
             style="padding: 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; ${!notif.isRead ? 'background: #f0f9ff;' : ''}">
            <div style="display: flex; justify-content: space-between;">
                <span style="font-weight: 600;">${escapeHtml(notif.title)}</span>
                <span style="font-size: 11px; color: #94a3b8;">${formatRelativeTime(notif.createdAt)}</span>
            </div>
            <div style="font-size: 13px; color: #475569; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${escapeHtml(notif.content)}
            </div>
            ${!notif.isRead ? '<span style="display: inline-block; width: 8px; height: 8px; background: #4f46e5; border-radius: 50%; margin-top: 6px;"></span>' : ''}
        </div>
    `).join('');
}

window.openNotificationDetail = async (notificationId) => {
    const notif = notifications.find(n => n.id === notificationId);
    if (!notif) return;
    
    if (!notif.isRead) {
        await markNotificationAsRead(notificationId);
    }
    
    const existingModal = document.querySelector('.notification-detail-overlay');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.className = 'notification-detail-overlay';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
    `;
    
    modal.innerHTML = `
        <div style="background: white; border-radius: 16px; padding: 24px; max-width: 400px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h3 style="font-size: 18px; margin: 0;">${escapeHtml(notif.title)}</h3>
                <button class="close-modal-btn" style="background: none; border: none; font-size: 20px; cursor: pointer; color: #64748b;">&times;</button>
            </div>
            <div style="font-size: 14px; color: #64748b; margin-bottom: 16px;">
                ${formatRelativeTime(notif.createdAt)} · 來自 ${escapeHtml(notif.senderName || '系統')}
            </div>
            <div style="font-size: 15px; line-height: 1.5; color: #1e293b; white-space: pre-wrap; margin-bottom: 20px;">
                ${escapeHtml(notif.content)}
            </div>
            <button class="close-modal-btn" style="width: 100%; background: #4f46e5; color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 500;">關閉</button>
        </div>
    `;
    
    const closeButtons = modal.querySelectorAll('.close-modal-btn');
    closeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
    
    document.body.appendChild(modal);
};

let notificationClickHandler = null;
let notificationEscapeHandler = null;

function handleNotificationClickOutside(event) {
    const panel = document.getElementById('notificationPanel');
    const bellButton = document.querySelector('button[onclick*="showNotificationPanel"]');
    
    if (panel && panel.contains(event.target)) return;
    if (bellButton && bellButton.contains(event.target)) return;
    
    if (panel && panel.style.display === 'block') {
        panel.style.display = 'none';
        document.removeEventListener('click', handleNotificationClickOutside);
        document.removeEventListener('keydown', handleNotificationEscapeKey);
    }
}

function handleNotificationEscapeKey(event) {
    if (event.key === 'Escape') {
        const panel = document.getElementById('notificationPanel');
        if (panel && panel.style.display === 'block') {
            panel.style.display = 'none';
            document.removeEventListener('click', handleNotificationClickOutside);
            document.removeEventListener('keydown', handleNotificationEscapeKey);
        }
    }
}

window.showNotificationPanel = () => {
    const panel = document.getElementById('notificationPanel');
    if (!panel) return;
    
    const isVisible = panel.style.display === 'block';
    
    if (isVisible) {
        panel.style.display = 'none';
        document.removeEventListener('click', handleNotificationClickOutside);
        document.removeEventListener('keydown', handleNotificationEscapeKey);
    } else {
        panel.style.display = 'block';
        renderNotificationList();
        
        setTimeout(() => {
            document.addEventListener('click', handleNotificationClickOutside);
            document.addEventListener('keydown', handleNotificationEscapeKey);
        }, 100);
    }
};

// === 獲取用戶角色 ===
async function getUserRole(userId) {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            return userSnap.data().role || 'user';
        }
        return 'user';
    } catch (error) {
        console.error('獲取角色失敗:', error);
        return 'user';
    }
}

// === 獲取用戶 Branch（陣列）===
async function getUserBranch(userId) {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            const branch = userSnap.data().branch;
            if (Array.isArray(branch)) return branch;
            if (branch) return [branch];
            return [];
        }
        return [];
    } catch (error) {
        console.error('獲取 Branch 失敗:', error);
        return [];
    }
}

// === 檢查帳號是否停用 ===
async function isUserDisabled(userId) {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            return userSnap.data().isDisabled === true;
        }
        return false;
    } catch (error) {
        console.error('檢查停用狀態失敗:', error);
        return false;
    }
}

// === 活躍度同步 ===
async function syncActivityToCloud() {
    if (!currentUser || isGuestMode) return;
    
    try {
        const userRef = doc(db, 'users', currentUser.uid);
        const totalTime = Object.values(learningStats).reduce((sum, stat) => sum + (stat.totalTime || 0), 0);
        
        await updateDoc(userRef, {
            totalLearningTime: totalTime,
            lastActiveAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        
        lastSyncTime = Date.now();
        console.log('✅ 活躍度已同步');
    } catch (error) {
        console.error('活躍度同步失敗:', error);
    }
}

// === 用戶介面更新（含訪客模式）===
function updateUserInterface() {
    const userInfoDiv = document.getElementById('userInfo');
    const userActionsDiv = document.getElementById('userActions');
    const uploadWrapper = document.getElementById('uploadWrapper');
    
    if (!userInfoDiv) return;
    
    if (isGuestMode) {
        const guestGradeDisplay = getGuestGrade();
        
        userInfoDiv.innerHTML = `
            <div style="width:40px;height:40px;border-radius:50%;background:#a0aec0;display:flex;align-items:center;justify-content:center;color:white;">
                <i class="fas fa-user"></i>
            </div>
            <div>
                <div class="user-name">訪客模式 · ${guestPublisher}</div>
                <div class="user-email">年級: ${guestGradeDisplay} | 進度儲存在本機</div>
            </div>
            <div class="sync-status" style="color:#f59e0b;">
                <i class="fas fa-info-circle"></i> 訪客模式
            </div>
        `;
        
        userActionsDiv.innerHTML = `
            <div style="display: flex; gap: 10px; align-items: center;">
                <select id="guestGradeSelect" style="padding: 6px 12px; border-radius: 8px; border: 1px solid #e2e8f0; background: white;">
                    <option value="P2" ${guestGradeDisplay === 'P2' ? 'selected' : ''}>P2 年級</option>
                    <option value="P5" ${guestGradeDisplay === 'P5' ? 'selected' : ''}>P5 年級</option>
                    <option value="S1" ${guestGradeDisplay === 'S1' ? 'selected' : ''}>S1 年級</option>
                </select>
                <button class="logout-btn" id="switchToLoginBtn" style="background: #4f46e5;">
                    <i class="fas fa-sign-in-alt"></i> 登入
                </button>
            </div>
        `;
        
        const gradeSelect = document.getElementById('guestGradeSelect');
        if (gradeSelect) {
            gradeSelect.addEventListener('change', async (e) => {
                const newGrade = e.target.value;
                setGuestGrade(newGrade);
                await loadUnitsIndex();
                updateUnitSelect();
                if (unitsIndex.units.length > 0) {
                    const availableUnits = filterUnitsForGuest(unitsIndex.units);
                    if (availableUnits.length > 0) {
                        await loadUnit(availableUnits[0].id);
                    }
                }
            });
        }
        
        const switchBtn = document.getElementById('switchToLoginBtn');
        if (switchBtn) {
            switchBtn.addEventListener('click', () => {
                localStorage.removeItem('guestMode');
                localStorage.removeItem('guestGrade');
                window.location.href = './login.html';
            });
        }
        
        if (uploadWrapper) uploadWrapper.style.display = 'none';
        
    } else if (currentUser && !isGuestMode) {
        const photoURL = currentUser.photoURL || '';
        const displayName = currentUser.displayName || currentUser.email || '用戶';
        const email = currentUser.email || '';
        
        let roleLabel = '';
        if (currentUserRole === 'admin') {
            roleLabel = '<span style="background:#4f46e5; color:white; padding:2px 8px; border-radius:20px; font-size:10px; margin-left:8px;">管理員</span>';
        } else if (currentUserRole === 'teacher') {
            roleLabel = '<span style="background:#f59e0b; color:white; padding:2px 8px; border-radius:20px; font-size:10px; margin-left:8px;">老師</span>';
        }
        
        let branchLabel = '';
        if (currentUserBranch && currentUserBranch.length > 0) {
            branchLabel = `<span style="background:#e2e8f0; color:#334155; padding:2px 8px; border-radius:20px; font-size:10px; margin-left:8px;">${escapeHtml(currentUserBranch.join(', '))}</span>`;
        }
        
        userInfoDiv.innerHTML = `
            ${photoURL ? `<img src="${photoURL}" class="user-avatar" alt="頭像">` : '<div style="width:40px;height:40px;border-radius:50%;background:#667eea;display:flex;align-items:center;justify-content:center;color:white;"><i class="fas fa-user"></i></div>'}
            <div>
                <div class="user-name">${escapeHtml(displayName)}${roleLabel}${branchLabel}</div>
                <div class="user-email">${escapeHtml(email)}</div>
            </div>
            <div class="sync-status" id="sync-status">
                <i class="fas fa-cloud-upload-alt"></i> 活躍中
            </div>
        `;
        
        userActionsDiv.innerHTML = `
            <div style="position: relative; margin-right: 15px;">
                <button onclick="showNotificationPanel()" style="background: none; border: none; cursor: pointer; position: relative;">
                    <i class="fas fa-bell" style="font-size: 18px; color: #64748b;"></i>
                    <span id="notificationBadge" style="position: absolute; top: -5px; right: -8px; background: #ef4444; color: white; font-size: 10px; padding: 2px 5px; border-radius: 10px; display: none;"></span>
                </button>
                <div id="notificationPanel" style="display: none; position: absolute; top: 40px; right: 0; width: 320px; max-height: 400px; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1000; overflow: hidden;">
                    <div style="padding: 12px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
                        <span style="font-weight: 600;">通知</span>
                        <button onclick="markAllNotificationsAsRead()" style="background: none; border: none; color: #4f46e5; cursor: pointer; font-size: 12px;">全部已讀</button>
                    </div>
                    <div id="notificationList" style="max-height: 350px; overflow-y: auto;"></div>
                </div>
            </div>
            <button class="logout-btn" id="logoutBtn">
                <i class="fas fa-sign-out-alt"></i> 登出
            </button>
        `;
        
        document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
        
        if (uploadWrapper) {
            if (currentUserRole === 'admin' || currentUserRole === 'teacher') {
                uploadWrapper.style.display = 'flex';
            } else {
                uploadWrapper.style.display = 'none';
            }
        }
        
    } else {
        window.location.href = './login.html';
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// === 登出處理 ===
async function handleLogout() {
    try {
        await syncActivityToCloud();
        await signOut(auth);
        currentUser = null;
        window.location.href = './login.html';
    } catch (error) {
        console.error('登出失敗:', error);
        window.location.href = './login.html';
    }
}

// === 訪客單元過濾 ===
function filterUnitsForGuest(units) {
    const guestGradeValue = getGuestGrade();
    return units.filter(unit => 
        unit.grade === guestGradeValue && 
        unit.publisher === guestPublisher
    );
}

// === 已登入用戶單元過濾 ===
function filterUnitsForUser(units) {
    if (!currentUserGrade) return units;
    if (!currentUserPublisher) return units;
    return units.filter(unit => 
        unit.grade === currentUserGrade && 
        unit.publisher === currentUserPublisher
    );
}

// === 數據管理 ===
async function loadUnitsIndex() {
    try {
        const response = await fetch(CONFIG.DATA_PATH + CONFIG.UNITS_INDEX + '?v=' + Date.now());
        if (!response.ok) throw new Error();
        unitsIndex = await response.json();
        return true;
    } catch (error) {
        console.error('加載單元索引失敗');
        unitsIndex = { units: [] };
        return false;
    }
}

async function loadUnitData(unitId) {
    const unitInfo = unitsIndex.units.find(u => u.id === unitId);
    if (unitInfo && unitInfo.dataUrl) {
        try {
            const response = await fetch(unitInfo.dataUrl);
            if (!response.ok) throw new Error();
            appData = await response.json();
            return true;
        } catch (error) {
            return false;
        }
    }
    try {
        const response = await fetch(`${CONFIG.DATA_PATH}${unitId}.json?v=${Date.now()}`);
        if (!response.ok) throw new Error();
        appData = await response.json();
        return true;
    } catch (error) {
        return false;
    }
}

function initStarData() {
    if (!appData) return;
    
    const allIds = [];
    appData.words.forEach(word => allIds.push(word.id));
    appData.sentences.forEach(sentence => allIds.push(sentence.id));
    
    allIds.forEach(id => {
        defaultStars[id] = 0;
        if (starData[id] === undefined) {
            starData[id] = 0;
        }
    });
}

function initLearningStats() {
    const savedStats = JSON.parse(localStorage.getItem('learningStats') || '{}');
    learningStats = savedStats;
    if (!learningStats[currentUnitId]) {
        learningStats[currentUnitId] = {
            totalTime: 0,
            lastAccessed: new Date().toISOString(),
            sessions: 0,
            mastery: 0
        };
    }
}

function updateLearningStats() {
    if (!learningStats[currentUnitId]) {
        learningStats[currentUnitId] = {
            totalTime: 0,
            lastAccessed: new Date().toISOString(),
            sessions: 0,
            mastery: 0
        };
    }
    learningStats[currentUnitId].lastAccessed = new Date().toISOString();
    learningStats[currentUnitId].sessions = (learningStats[currentUnitId].sessions || 0) + 1;
    saveLearningStats();
}

function saveLearningStats() {
    localStorage.setItem('learningStats', JSON.stringify(learningStats));
    updateDataStatus();
}

function saveStarData() {
    localStorage.setItem('starData', JSON.stringify(starData));
    updateDataStatus();
}

function updateDataStatus() {
    const status = document.getElementById('data-status');
    if (status) {
        status.classList.add('saving');
        setTimeout(() => status.classList.remove('saving'), 500);
    }
}

// === 卡片生成 ===
function generateWordCard(word, index) {
    const number = `單詞 ${index + 1}`;
    return `
        <div class="card-container">
            <div class="flashcard" onclick="flipCard(this)">
                <div class="card-front">
                    <div class="card-number">${number}</div>
                    <div class="card-content">
                        <div class="stars-container" id="${word.id}-stars"></div>
                    </div>
                    <div class="audio-buttons">
                        <button class="audio-btn" onclick="audioPlayer.playAudio('${word.audio}', this, event)">
                            <i class="fas fa-volume-up"></i>
                        </button>
                    </div>
                </div>
                <div class="card-back">
                    <div class="card-number">${number}</div>
                    <div class="card-content">
                        <div class="answer-text">${word.english}</div>
                        <div class="translation-text">${word.translation}</div>
                        ${word.hint ? `<div class="hint-text">${word.hint}</div>` : ''}
                    </div>
                    <div class="action-buttons">
                        <button class="action-btn correct-btn" onclick="markCorrect('${word.id}', event)" disabled>
                            <i class="fas fa-check"></i>
                        </button>
                        <button class="action-btn review-btn" onclick="markReview('${word.id}', event)" disabled>
                            <i class="fas fa-book"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function generateSentenceCard(sentence, index) {
    const number = `句子 ${index + 1}`;
    return `
        <div class="card-container sentence-card">
            <div class="flashcard" onclick="flipCard(this)">
                <div class="card-front">
                    <div class="card-number">${number}</div>
                    <div class="card-content">
                        <div class="stars-container" id="${sentence.id}-stars"></div>
                    </div>
                    <div class="audio-buttons">
                        <button class="audio-btn" onclick="audioPlayer.playAudio('${sentence.audio}', this, event)">
                            <i class="fas fa-volume-up"></i>
                        </button>
                    </div>
                </div>
                <div class="card-back">
                    <div class="card-number">${number}</div>
                    <div class="card-content">
                        <div class="answer-text">${sentence.english}</div>
                        <div class="translation-text">${sentence.translation}</div>
                    </div>
                    <div class="action-buttons">
                        <button class="action-btn correct-btn" onclick="markCorrect('${sentence.id}', event)" disabled>
                            <i class="fas fa-check"></i>
                        </button>
                        <button class="action-btn review-btn" onclick="markReview('${sentence.id}', event)" disabled>
                            <i class="fas fa-book"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function generateCards() {
    const wordsGrid = document.getElementById('words-grid');
    if (wordsGrid && appData.words.length > 0) {
        wordsGrid.innerHTML = appData.words.map((word, index) => generateWordCard(word, index)).join('');
    }
    const sentencesGrid = document.getElementById('sentences-grid');
    if (sentencesGrid && appData.sentences.length > 0) {
        sentencesGrid.innerHTML = appData.sentences.map((sentence, index) => generateSentenceCard(sentence, index)).join('');
    }
    updateStats();
}

// === 卡片操作 ===
function flipCard(card) {
    card.classList.toggle('flipped');
    const cardId = getCardId(card);
    
    if (card.classList.contains('flipped')) {
        updateButtonsState(cardId);
        
        if (!card.dataset.audioPlayed) {
            const audioBtn = card.querySelector('.audio-btn');
            if (audioBtn && !audioBtn.disabled) {
                const onclickAttr = audioBtn.getAttribute('onclick');
                const match = onclickAttr && onclickAttr.match(/playAudio\('([^']+)'/);
                if (match && match[1]) {
                    const audioKey = match[1];
                    const mockEvent = { stopPropagation: () => {}, preventDefault: () => {} };
                    audioPlayer.playAudio(audioKey, audioBtn, mockEvent);
                    card.dataset.audioPlayed = 'true';
                }
            }
        }
    } else {
        disableButtons(cardId);
        
        if (audioPlayer.isPlaying) {
            audioPlayer.stopCurrentAudio();
        }
    }
}

function getCardId(cardElement) {
    const starsContainer = cardElement.querySelector('.stars-container');
    return starsContainer && starsContainer.id ? starsContainer.id.replace('-stars', '') : null;
}

function updateButtonsState(cardId) {
    if (!cardId) return;
    const stars = starData[cardId] || 0;
    const card = document.querySelector(`#${cardId}-stars`)?.closest('.flashcard');
    if (!card) return;
    const correctBtn = card.querySelector('.correct-btn');
    const reviewBtn = card.querySelector('.review-btn');
    if (correctBtn) correctBtn.disabled = (stars >= 5);
    if (reviewBtn) reviewBtn.disabled = (stars <= 0);
}

function disableButtons(cardId) {
    if (!cardId) return;
    const card = document.querySelector(`#${cardId}-stars`)?.closest('.flashcard');
    if (card) {
        card.querySelectorAll('.action-btn').forEach(btn => btn.disabled = true);
    }
}

function createStars(cardId, count) {
    const container = document.getElementById(cardId + '-stars');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const star = document.createElement('div');
        star.className = 'star' + (i < count ? ' active' : '');
        star.innerHTML = '★';
        container.appendChild(star);
    }
}

function markCorrect(cardId, event) {
    stopPropagation(event);
    if (starData[cardId] < 5) {
        starData[cardId]++;
        saveStarData();
        createStars(cardId, starData[cardId]);
        updateStats();
        updateLearningStats();
        const btn = event.target.closest('.correct-btn');
        if (btn) {
            btn.disabled = true;
            setTimeout(() => updateButtonsState(cardId), 300);
        }
    }
}

function markReview(cardId, event) {
    stopPropagation(event);
    if (starData[cardId] > 0) {
        starData[cardId]--;
        saveStarData();
        createStars(cardId, starData[cardId]);
        updateStats();
        updateLearningStats();
        const btn = event.target.closest('.review-btn');
        if (btn) {
            btn.disabled = true;
            setTimeout(() => updateButtonsState(cardId), 300);
        }
    }
}

// === 統計更新 ===
function updateStats() {
    if (!appData) return;
    
    const wordIds = appData.words.map(word => word.id);
    const sentenceIds = appData.sentences.map(sentence => sentence.id);
    
    const wordStars = wordIds.map(id => starData[id] || 0);
    const sentenceStars = sentenceIds.map(id => starData[id] || 0);
    
    const totalWords = wordIds.length;
    const masteredWords = wordStars.filter(v => v === 5).length;
    const totalSentences = sentenceIds.length;
    const masteredSentences = sentenceStars.filter(v => v === 5).length;
    
    const wordsMastery = totalWords > 0 ? Math.round((masteredWords / totalWords) * 100) : 0;
    const sentencesMastery = totalSentences > 0 ? Math.round((masteredSentences / totalSentences) * 100) : 0;
    
    document.getElementById('total-words').textContent = totalWords;
    document.getElementById('mastered-words').textContent = masteredWords;
    document.getElementById('words-mastery').textContent = wordsMastery + '%';
    
    document.getElementById('total-sentences').textContent = totalSentences;
    document.getElementById('mastered-sentences').textContent = masteredSentences;
    document.getElementById('sentences-mastery').textContent = sentencesMastery + '%';
    
    if (learningStats[currentUnitId]) {
        const totalItems = totalWords + totalSentences;
        const totalMastered = masteredWords + masteredSentences;
        learningStats[currentUnitId].mastery = totalItems > 0 ? Math.round((totalMastered / totalItems) * 100) : 0;
        saveLearningStats();
    }
    
    updateUnitStatsDisplay();
}

function updateUnitStatsDisplay() {
    const statsGrid = document.getElementById('unit-stats-grid');
    const statsList = document.getElementById('unit-stats-list');
    if (!statsGrid || !statsList || !appData) return;
    
    const wordIds = appData.words.map(word => word.id);
    const sentenceIds = appData.sentences.map(sentence => sentence.id);
    const wordStars = wordIds.map(id => starData[id] || 0);
    const sentenceStars = sentenceIds.map(id => starData[id] || 0);
    const totalWords = wordIds.length;
    const masteredWords = wordStars.filter(v => v === 5).length;
    const totalSentences = sentenceIds.length;
    const masteredSentences = sentenceStars.filter(v => v === 5).length;
    const totalItems = totalWords + totalSentences;
    const totalMastered = masteredWords + masteredSentences;
    const overallMastery = totalItems > 0 ? Math.round((totalMastered / totalItems) * 100) : 0;
    
    const unitStats = learningStats[currentUnitId] || {};
    
    statsGrid.innerHTML = `
        <div class="unit-stat-item" style="background:#f8fafc; border-radius:12px; padding:15px;">
            <div style="font-size:32px; font-weight:700;">${overallMastery}%</div>
            <div>整體掌握度</div>
            <div style="height:6px; background:#e2e8f0; border-radius:3px; margin:8px 0;"><div style="width:${overallMastery}%; height:100%; background:#48bb78; border-radius:3px;"></div></div>
            <div style="font-size:12px; color:#718096;">${totalMastered}/${totalItems} 個項目</div>
        </div>
        <div class="unit-stat-item" style="background:#f8fafc; border-radius:12px; padding:15px;">
            <div style="font-size:32px; font-weight:700;">${formatTime(unitStats.totalTime || 0)}</div>
            <div>學習時長</div>
        </div>
        <div class="unit-stat-item" style="background:#f8fafc; border-radius:12px; padding:15px;">
            <div style="font-size:32px; font-weight:700;">${unitStats.sessions || 0}</div>
            <div>學習次數</div>
        </div>
        <div class="unit-stat-item" style="background:#f8fafc; border-radius:12px; padding:15px;">
            <div style="font-size:32px; font-weight:700;">${formatDate(unitStats.lastAccessed)}</div>
            <div>最後學習</div>
        </div>
    `;
    
    let statsListHTML = '';
    for (const unitId in learningStats) {
        const stat = learningStats[unitId];
        const unitInfo = unitsIndex.units?.find(u => u.id === unitId) || { title: unitId };
        statsListHTML += `
            <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #edf2f7;">
                <span>${unitInfo.title}</span>
                <span style="color:#718096;">${formatTime(stat.totalTime || 0)} | 掌握度: ${stat.mastery || 0}% | 次數: ${stat.sessions || 0}</span>
            </div>
        `;
    }
    statsList.innerHTML = statsListHTML || '<div style="padding:10px; color:#718096;">暫無學習記錄</div>';
}

// === 分頁管理 ===
function showTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    document.querySelectorAll('.cards-section').forEach(section => section.classList.remove('active'));
    document.getElementById(tabName + '-cards').classList.add('active');
}

// === 單元管理 ===
async function loadUnit(unitId) {
    if (!unitId || unitId === currentUnitId) return;
    currentUnitId = unitId;
    
    document.getElementById('words-grid').innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> 載入中...</div>';
    document.getElementById('sentences-grid').innerHTML = '';
    
    const success = await loadUnitData(unitId);
    if (success) {
        initStarData();
        initLearningStats();
        generateCards();
        
        Object.keys(starData).forEach(key => {
            createStars(key, starData[key]);
            disableButtons(key);
        });
        
        document.getElementById('unit-select').value = unitId;
        updateLearningStats();
        updateUrlParam('unit', unitId);
    } else {
        document.getElementById('words-grid').innerHTML = '<div class="loading">載入失敗</div>';
    }
}

function updateUnitSelect() {
    const unitSelect = document.getElementById('unit-select');
    if (!unitSelect) return;
    
    // 確保 unitsIndex 有數據
    if (!unitsIndex || !unitsIndex.units || unitsIndex.units.length === 0) {
        console.log('unitsIndex 尚未載入，等待...');
        unitSelect.innerHTML = '<option value="">載入中...</option>';
        return;
    }
    
    unitSelect.innerHTML = '';
    
    let availableUnits = [];
    
    if (isGuestMode) {
        availableUnits = filterUnitsForGuest(unitsIndex.units);
    } else if (currentUser) {
        if (currentUserGrade && currentUserPublisher) {
            availableUnits = unitsIndex.units.filter(unit => 
                unit.grade === currentUserGrade && 
                unit.publisher === currentUserPublisher
            );
            console.log('過濾後可用單元數量:', availableUnits.length);
        } else {
            availableUnits = unitsIndex.units;
        }
    } else {
        availableUnits = unitsIndex.units;
    }
    
    if (availableUnits.length === 0) {
        console.log('無可用單元，清除卡片內容');
        unitSelect.innerHTML = '<option value="">沒有可用的單元</option>';
        
        // 強制清除卡片內容
        const wordsGrid = document.getElementById('words-grid');
        const sentencesGrid = document.getElementById('sentences-grid');
        if (wordsGrid) {
            // 清空所有子元素
            while (wordsGrid.firstChild) {
                wordsGrid.removeChild(wordsGrid.firstChild);
            }
            wordsGrid.innerHTML = '<div class="loading">📭 沒有找到符合的單元</div>';
        }
        if (sentencesGrid) {
            while (sentencesGrid.firstChild) {
                sentencesGrid.removeChild(sentencesGrid.firstChild);
            }
            sentencesGrid.innerHTML = '';
        }
        
        // 清除 appData 和 currentUnitId
        appData = null;
        currentUnitId = '';
        
        return;
    }
    
    availableUnits.forEach(unit => {
        const option = document.createElement('option');
        option.value = unit.id;
        option.textContent = unit.title;
        unitSelect.appendChild(option);
    });
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const unitData = JSON.parse(text);
        if (!unitData.unit_id || !unitData.unit_title || !unitData.words || !unitData.sentences) {
            throw new Error('無效格式');
        }
        const existingIndex = unitsIndex.units.findIndex(u => u.id === unitData.unit_id);
        const tempUnit = {
            id: unitData.unit_id,
            title: unitData.unit_title,
            description: unitData.unit_description || '自定義單元',
            words_count: unitData.words.length,
            sentences_count: unitData.sentences.length,
            difficulty: unitData.difficulty || 'custom',
            created: new Date().toISOString().split('T')[0],
            dataUrl: URL.createObjectURL(file)
        };
        if (existingIndex !== -1) {
            if (unitsIndex.units[existingIndex].dataUrl?.startsWith('blob:')) {
                URL.revokeObjectURL(unitsIndex.units[existingIndex].dataUrl);
            }
            unitsIndex.units[existingIndex] = tempUnit;
        } else {
            unitsIndex.units.push(tempUnit);
        }
        updateUnitSelect();
        await loadUnit(tempUnit.id);
    } catch (error) {
        console.error('上傳失敗', error);
    } finally {
        event.target.value = '';
    }
}

function updateUrlParam(key, value) {
    const url = new URL(window.location);
    url.searchParams.set(key, value);
    window.history.replaceState({}, '', url);
}

function getUrlParam(key) {
    return new URLSearchParams(window.location.search).get(key);
}

// === 重置功能 ===
function resetCurrentTabData(event) {
    stopPropagation(event);
    if (!appData) return;
    const activeSection = document.querySelector('.cards-section.active');
    if (!activeSection) return;
    const isWords = activeSection.id === 'words-cards';
    if (isWords && appData.words) {
        appData.words.forEach(word => starData[word.id] = 0);
    } else if (!isWords && appData.sentences) {
        appData.sentences.forEach(sentence => starData[sentence.id] = 0);
    }
    saveStarData();
    Object.keys(starData).forEach(key => createStars(key, starData[key]));
    updateStats();
    document.querySelectorAll('.flashcard').forEach(card => {
        card.classList.remove('flipped');
        delete card.dataset.audioPlayed;
        const id = getCardId(card);
        if (id) disableButtons(id);
    });
}

function resetAllUnitsData(event) {
    stopPropagation(event);
    localStorage.removeItem('starData');
    localStorage.removeItem('learningStats');
    starData = {};
    learningStats = {};
    
    if (appData) {
        initStarData();
        initLearningStats();
        Object.keys(starData).forEach(key => createStars(key, starData[key]));
        updateStats();
        document.querySelectorAll('.flashcard').forEach(card => {
            card.classList.remove('flipped');
            delete card.dataset.audioPlayed;
            const id = getCardId(card);
            if (id) disableButtons(id);
        });
    }
}

// === 全局變量（已登入用戶）===
let currentUserGrade = null;
let currentUserPublisher = null;

// === 獲取用戶年級和教材 ===
async function getUserGradeAndPublisher(userId) {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            const data = userSnap.data();
            currentUserGrade = data.grade || null;
            
            // 只使用 publishers 陣列
            if (data.publishers && Array.isArray(data.publishers) && data.publishers.length > 0) {
                currentUserPublisher = data.publishers[0];  // 取第一個教材
            } else {
                currentUserPublisher = null;
            }
            
            console.log('📚 用戶年級:', currentUserGrade, '教材:', currentUserPublisher);
        }
    } catch (error) {
        console.error('獲取用戶年級/教材失敗:', error);
    }
}

// === 初始化 ===
async function initPage() {
    const guestModeFlag = localStorage.getItem('guestMode');
    if (guestModeFlag === 'true') {
        isGuestMode = true;
        guestGrade = getGuestGrade();
        console.log('👤 訪客模式啟動，年級:', guestGrade);
        
        const indexLoaded = await loadUnitsIndex();
        if (indexLoaded && unitsIndex.units.length) {
            updateUnitSelect();
            const availableUnits = filterUnitsForGuest(unitsIndex.units);
            if (availableUnits.length > 0) {
                await loadUnit(availableUnits[0].id);
            }
            document.getElementById('unit-select').addEventListener('change', function() {
                loadUnit(this.value);
            });
        } else {
            document.getElementById('words-grid').innerHTML = '<div class="loading">無法載入單元列表</div>';
        }
        
        updateUserInterface();
        
        document.getElementById('show-unit-stats')?.addEventListener('click', () => {
            document.getElementById('unit-stats-modal').classList.add('active');
            updateUnitStatsDisplay();
        });
        document.getElementById('close-stats')?.addEventListener('click', () => {
            document.getElementById('unit-stats-modal').classList.remove('active');
        });
        document.getElementById('unit-stats-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
        });
        
        return;
    }
    
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            console.log('✅ 用戶已登入:', user.email);
            
            const isDisabled = await isUserDisabled(user.uid);
            if (isDisabled) {
                console.log('🔒 帳號已被停用，拒絕登入');
                await signOut(auth);
                alert('您的帳號已被停用，請聯絡管理員');
                window.location.href = './login.html';
                return;
            }
            
            currentUser = user;
            isGuestMode = false;
            
            currentUserRole = await getUserRole(user.uid);
            currentUserBranch = await getUserBranch(user.uid);
            await getUserGradeAndPublisher(user.uid);
            console.log('👤 用戶角色:', currentUserRole, 'Branch:', currentUserBranch);
            
            const savedStarData = localStorage.getItem('starData');
            if (savedStarData) starData = JSON.parse(savedStarData);
            
            const savedStats = localStorage.getItem('learningStats');
            if (savedStats) learningStats = JSON.parse(savedStats);
            
            try {
                const userRef = doc(db, 'users', user.uid);
                const userSnap = await getDoc(userRef);
                
                if (userSnap.exists()) {
                    const currentData = userSnap.data();
                    await updateDoc(userRef, {
                        lastLoginAt: new Date().toISOString(),
                        lastActiveAt: new Date().toISOString(),
                        loginCount: (currentData.loginCount || 0) + 1,
                        updatedAt: new Date().toISOString()
                    });
                }
            } catch (error) {
                console.error('更新用戶活躍度失敗:', error);
            }
            
            updateUserInterface();
            await loadNotifications();
            
const indexLoaded = await loadUnitsIndex();
console.log('loadUnitsIndex 完成, indexLoaded:', indexLoaded);
console.log('unitsIndex.units 數量:', unitsIndex.units.length);

if (indexLoaded && unitsIndex.units.length) {
    // 確保 unitsIndex 有數據後再調用 updateUnitSelect
    updateUnitSelect();
    console.log('updateUnitSelect 調用完成');
    
   let unitToLoad = getUrlParam('unit');
console.log('URL 參數 unit:', unitToLoad);

// 檢查 URL 指定的單元是否對當前用戶可見
if (unitToLoad && unitsIndex.units.find(u => u.id === unitToLoad)) {
    const targetUnit = unitsIndex.units.find(u => u.id === unitToLoad);
    
    // 如果用戶有年級和教材限制，檢查該單元是否符合
    if (currentUserGrade && currentUserPublisher) {
        if (targetUnit.grade === currentUserGrade && targetUnit.publisher === currentUserPublisher) {
            // 符合條件，可以使用
            console.log('✅ URL 指定的單元符合用戶條件:', unitToLoad);
        } else {
            // 不符合條件，忽略 URL 參數
            console.log('❌ URL 指定的單元不符合用戶條件 (grade:', targetUnit.grade, 'publisher:', targetUnit.publisher, ')，忽略');
            unitToLoad = null;
        }
    } else {
        // 用戶沒有年級/教材限制，可以使用
        console.log('✅ 用戶無年級/教材限制，使用 URL 指定的單元:', unitToLoad);
    }
}

// 如果沒有 URL 參數或 URL 參數無效/不符合條件，獲取可用單元
if (!unitToLoad || !unitsIndex.units.find(u => u.id === unitToLoad)) {
    const availableUnits = filterUnitsForUser(unitsIndex.units);
    console.log('filterUnitsForUser 結果數量:', availableUnits.length);
    if (availableUnits.length > 0) {
        unitToLoad = availableUnits[0].id;
        console.log('將載入第一個可用單元:', unitToLoad);
    } else {
        // 沒有可用單元時，不要載入任何單元
        unitToLoad = null;
        console.log('沒有可用單元，設置 unitToLoad = null');
    }
}
    
    // 只有當有可用單元時才載入
    if (unitToLoad) {
        console.log('開始載入單元:', unitToLoad);
        await loadUnit(unitToLoad);
    } else {
        console.log('沒有可用單元，清除卡片內容');
        // 確保卡片內容被清除
        const wordsGrid = document.getElementById('words-grid');
        const sentencesGrid = document.getElementById('sentences-grid');
        
        // 使用多種方式確保清除
        if (wordsGrid) {
            while (wordsGrid.firstChild) {
                wordsGrid.removeChild(wordsGrid.firstChild);
            }
            wordsGrid.innerHTML = '<div class="loading">📭 沒有找到符合的單元</div>';
        }
        if (sentencesGrid) {
            while (sentencesGrid.firstChild) {
                sentencesGrid.removeChild(sentencesGrid.firstChild);
            }
            sentencesGrid.innerHTML = '';
        }
        appData = null;
        currentUnitId = '';
    }
    
    document.getElementById('unit-select').addEventListener('change', function() {
        loadUnit(this.value);
    });
    document.getElementById('unit-upload').addEventListener('change', handleFileUpload);
} else {
    console.log('無法載入單元列表');
    document.getElementById('words-grid').innerHTML = '<div class="loading">無法載入單元列表</div>';
}
            
        } else {
            window.location.href = './login.html';
        }
    });
    
    document.getElementById('show-unit-stats')?.addEventListener('click', () => {
        document.getElementById('unit-stats-modal').classList.add('active');
        updateUnitStatsDisplay();
    });
    document.getElementById('close-stats')?.addEventListener('click', () => {
        document.getElementById('unit-stats-modal').classList.remove('active');
    });
    document.getElementById('unit-stats-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
    });
    
    setInterval(() => {
        if (learningStats[currentUnitId]) {
            learningStats[currentUnitId].totalTime = (learningStats[currentUnitId].totalTime || 0) + 0.5;
            saveLearningStats();
        }
    }, 30000);
    
    setInterval(() => {
        if (currentUser && !isGuestMode) {
            syncActivityToCloud();
        }
    }, 300000);
    
    window.addEventListener('beforeunload', () => {
        if (currentUser && !isGuestMode) {
            syncActivityToCloud();
        }
    });
}

// 掛載全局函數
window.flipCard = flipCard;
window.markCorrect = markCorrect;
window.markReview = markReview;
window.showTab = showTab;
window.resetCurrentTabData = resetCurrentTabData;
window.resetAllUnitsData = resetAllUnitsData;
window.audioPlayer = audioPlayer;
window.openNotificationDetail = openNotificationDetail;
window.showNotificationPanel = showNotificationPanel;
window.markAllNotificationsAsRead = markAllNotificationsAsRead;

// 啟動應用
window.addEventListener('load', initPage);