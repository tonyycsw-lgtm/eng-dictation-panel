// === 導入 Firebase 模組 ===
import { auth, db, doc, getDoc, setDoc, updateDoc, increment, signOut, onAuthStateChanged } from './firebase-config.js';

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
let currentUserBranch = null;
let isGuestMode = false;
let lastSyncTime = null;

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

// === 獲取用戶 Branch ===
async function getUserBranch(userId) {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            return userSnap.data().branch || null;
        }
        return null;
    } catch (error) {
        console.error('獲取 Branch 失敗:', error);
        return null;
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

// === 用戶介面更新 ===
function updateUserInterface() {
    const userInfoDiv = document.getElementById('userInfo');
    const userActionsDiv = document.getElementById('userActions');
    const uploadWrapper = document.getElementById('uploadWrapper');
    
    if (!userInfoDiv) return;
    
    if (currentUser && !isGuestMode) {
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
        if (currentUserBranch) {
            branchLabel = `<span style="background:#e2e8f0; color:#334155; padding:2px 8px; border-radius:20px; font-size:10px; margin-left:8px;">${escapeHtml(currentUserBranch)}</span>`;
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
            <button class="logout-btn" id="logoutBtn">
                <i class="fas fa-sign-out-alt"></i> 登出
            </button>
        `;
        
        document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
        
        // 上傳按鈕權限控制
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
    unitSelect.innerHTML = '';
    unitsIndex.units.forEach(unit => {
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

// === 初始化 ===
async function initPage() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            console.log('✅ 用戶已登入:', user.email);
            
            // 檢查帳號是否停用
            const isDisabled = await isUserDisabled(user.uid);
            if (isDisabled) {
                console.log('🔒 帳號已被停用，拒絕登入');
                await signOut(auth);
                alert('您的帳號已被停用，請聯絡管理員');
                window.location.href = './login.html';
                return;
            }
            
            currentUser = user;
            
            // 獲取用戶角色和 Branch
            currentUserRole = await getUserRole(user.uid);
            currentUserBranch = await getUserBranch(user.uid);
            console.log('👤 用戶角色:', currentUserRole, 'Branch:', currentUserBranch);
            
            // 載入本地數據
            const savedStarData = localStorage.getItem('starData');
            if (savedStarData) starData = JSON.parse(savedStarData);
            
            const savedStats = localStorage.getItem('learningStats');
            if (savedStats) learningStats = JSON.parse(savedStats);
            
            // 更新用戶活躍度
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
            
            // 載入單元
            if (currentUnitId && appData) {
                generateCards();
                Object.keys(starData).forEach(key => {
                    createStars(key, starData[key]);
                    disableButtons(key);
                });
                updateStats();
            }
            
        } else {
            window.location.href = './login.html';
        }
    });
    
    // 載入單元索引
    const indexLoaded = await loadUnitsIndex();
    if (indexLoaded && unitsIndex.units.length) {
        updateUnitSelect();
        let unitToLoad = getUrlParam('unit');
        if (!unitToLoad || !unitsIndex.units.find(u => u.id === unitToLoad)) {
            unitToLoad = CONFIG.DEFAULT_UNIT;
        }
        await loadUnit(unitToLoad);
        document.getElementById('unit-select').addEventListener('change', function() {
            loadUnit(this.value);
        });
        document.getElementById('unit-upload').addEventListener('change', handleFileUpload);
    } else {
        document.getElementById('words-grid').innerHTML = '<div class="loading">無法載入單元列表</div>';
    }
    
    // 統計彈窗
    document.getElementById('show-unit-stats').addEventListener('click', () => {
        document.getElementById('unit-stats-modal').classList.add('active');
        updateUnitStatsDisplay();
    });
    document.getElementById('close-stats').addEventListener('click', () => {
        document.getElementById('unit-stats-modal').classList.remove('active');
    });
    document.getElementById('unit-stats-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
    });
    
    // 學習時間記錄
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

window.addEventListener('load', initPage);