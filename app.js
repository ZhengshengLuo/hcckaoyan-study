// ==========================================
// 1. Role & Identity Management
// ==========================================
console.log("=== APP.JS START ===");

// Safe LocalStorage wrapper to prevent file:// protocol exceptions
const SafeStorage = {
    getItem: function(key) {
        try { return localStorage.getItem(key); } catch (e) { return window['tempStorage_' + key]; }
    },
    setItem: function(key, val) {
        try { localStorage.setItem(key, val); } catch (e) { window['tempStorage_' + key] = val; }
    },
    removeItem: function(key) {
        try { localStorage.removeItem(key); } catch (e) { delete window['tempStorage_' + key]; }
    }
};

// Role is stored per-tab via sessionStorage, so two tabs can be girl + boy
let currentRole = null;
try { currentRole = sessionStorage.getItem('userRole'); } catch(e) { currentRole = window._tabRole || null; }

function initRoleUI() {
    const overlay = document.getElementById('role-overlay');
    
    if (!currentRole) {
        overlay.style.display = 'flex';
        
        document.querySelectorAll('.role-card').forEach(card => {
            card.addEventListener('click', () => {
                const selected = card.getAttribute('data-role');
                
                // Add password protection for Guardian (Boy) role
                if (selected === 'boy') {
                    const pwd = prompt('请输入守护者专属密码：');
                    if (pwd !== '5201314') {
                        alert('密码错误！你不是我的守护者哼！');
                        return;
                    }
                }
                
                currentRole = selected;
                try { sessionStorage.setItem('userRole', currentRole); } catch(e) { window._tabRole = currentRole; }
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.style.display = 'none';
                    applyRoleConstraints();
                    initAllChannels();
                }, 500);
            });
        });
    } else {
        overlay.style.display = 'none';
        applyRoleConstraints();
        initAllChannels();
    }
}

document.getElementById('reset-role-btn').addEventListener('click', () => {
    try { sessionStorage.removeItem('userRole'); } catch(e) { window._tabRole = null; }
    location.reload();
});

// Logout button in the sidebar
document.getElementById('logout-btn').addEventListener('click', () => {
    try { sessionStorage.removeItem('userRole'); } catch(e) { window._tabRole = null; }
    location.reload();
});

function applyRoleConstraints() {
    // Show the main application container!
    document.getElementById('main-app').classList.remove('hidden');

    document.querySelectorAll('.girl-only').forEach(el => {
        el.style.display = currentRole === 'girl' ? 'flex' : 'none';
    });
    document.querySelectorAll('.boy-only').forEach(el => {
        el.style.display = currentRole === 'boy' ? 'flex' : 'none';
    });

    const avatarImg = document.getElementById('sidebar-avatar');
    const nameText = document.getElementById('sidebar-name');
    
    if (currentRole === 'girl') {
        avatarImg.src = "./melody.png";
        avatarImg.style.borderColor = "#ffb7c5";
        avatarImg.style.backgroundColor = "#ffe6f2";
        nameText.innerText = "☁️ 随心学习中...";
        document.querySelector('.nav-btn[data-target="timer-view"]').click();
        // Bug #3 fix: restore timer state AFTER role is set
        restoreTimerState();
    } else if (currentRole === 'boy') {
        avatarImg.src = "./kuromi.png";
        avatarImg.style.borderColor = "#a29bfe";
        avatarImg.style.backgroundColor = "#e6e6fa";
        nameText.innerText = "👀 默默守护中...";
        document.querySelector('.nav-btn[data-target="dashboard-view"]').click();
    }
    
    // Re-render rewards to apply role-specific buttons (delete vs redeem)
    renderRewardsFromConfig(currentRewardsConfig);
}

// ==========================================
// 2. P2P Communication (Dual Channel)
//    - BroadcastChannel: same browser, instant
//    - MQTT: cross-device, requires network
// ==========================================

// --- Shared data (use shared keys so both roles read the same data) ---
let currentPoints = parseInt(SafeStorage.getItem('totalPoints') || '120');
let studyHistory = JSON.parse(SafeStorage.getItem('studyHistory') || '[]');
let rewardHistory = JSON.parse(SafeStorage.getItem('rewardHistory') || '[]');
let currentTimerState = SafeStorage.getItem('currentTimerState') || '休息中';

document.getElementById('points-display').innerText = currentPoints;

// --- BroadcastChannel (local, same-origin tabs) ---
let localChannel = null;

function initLocalChannel() {
    try {
        localChannel = new BroadcastChannel('cspin_study_tracker');
        console.log("[LOCAL] BroadcastChannel created");

        localChannel.onmessage = function(event) {
            const msg = event.data;
            console.log("[LOCAL] Received:", msg.type);
            handleIncomingMessage(msg);
        };
    } catch (e) {
        console.warn("[LOCAL] BroadcastChannel not available:", e);
    }
}

function localBroadcast(msg) {
    if (localChannel) {
        try {
            localChannel.postMessage(msg);
            console.log("[LOCAL] Sent:", msg.type);
        } catch (e) {
            console.warn("[LOCAL] Send failed:", e);
        }
    }
}

// --- MQTT (remote, cross-device) ---
// Try multiple public brokers as fallback
const MQTT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://public.mqtthq.com:8084/mqtt",
    "wss://test.mosquitto.org:8081/mqtt"
];
// Secret topics for two-player sync
const SECRET_BASE_TOPIC = "cspin_study_hcc_zsl_8f9a2b_v2";
const TOPIC_STATE = SECRET_BASE_TOPIC + "/state";
const TOPIC_CONFIG = SECRET_BASE_TOPIC + "/config";
const TOPIC_EVENTS = SECRET_BASE_TOPIC + "/events";

let mqttClient = null;
let mqttClientId = null;
let mqttConnected = false;

function initMQTT(brokerIndex) {
    brokerIndex = brokerIndex || 0;
    
    if (typeof mqtt === 'undefined') {
        console.warn("[MQTT] Library not loaded, skipping MQTT init");
        showToast('⚠️ MQTT库未加载，跨设备同步不可用', 4000);
        updateMqttStatusUI(false, '库未加载');
        return;
    }
    
    if (brokerIndex >= MQTT_BROKERS.length) {
        showToast('❌ 所有MQTT服务器连接失败，跨设备同步不可用', 5000);
        updateMqttStatusUI(false, '全部失败');
        return;
    }
    
    var brokerUrl = MQTT_BROKERS[brokerIndex];
    mqttClientId = 'cspin_' + currentRole + '_' + Math.random().toString(36).substring(2, 8);
    
    showToast('🔄 正在连接同步服务器...', 3000);
    
    try {
        if (mqttClient) {
            try { mqttClient.end(true); } catch(e) {}
            mqttClient = null;
        }
        
        mqttClient = mqtt.connect(brokerUrl, {
            clientId: mqttClientId,
            reconnectPeriod: 5000,
            connectTimeout: 8000,
            keepalive: 30
        });
    } catch (e) {
        setTimeout(function() { initMQTT(brokerIndex + 1); }, 500);
        return;
    }
    
    var connectTimeout = setTimeout(function() {
        if (!mqttConnected) {
            try { mqttClient.end(true); } catch(e) {}
            mqttClient = null;
            initMQTT(brokerIndex + 1);
        }
    }, 10000);
    
    mqttClient.on('connect', function() {
        clearTimeout(connectTimeout);
        mqttConnected = true;
        showToast('✅ 云端已连接！', 3000);
        updateMqttStatusUI(true);
        
        mqttClient.subscribe(TOPIC_STATE);
        mqttClient.subscribe(TOPIC_CONFIG);
        mqttClient.subscribe(TOPIC_EVENTS);
        
        if (currentRole === 'girl') {
            publishState();
        }
    });

    mqttClient.on('reconnect', function() { updateMqttStatusUI(false, '重连中...'); });
    mqttClient.on('offline', function() { mqttConnected = false; updateMqttStatusUI(false, '离线'); });
    mqttClient.on('error', function(err) { updateMqttStatusUI(false, '错误'); });
    
    mqttClient.on('message', function(topic, message, packet) {
        try {
            const msg = JSON.parse(message.toString());
            // Ignore messages from self, unless they are explicitly retained sync messages
            if (msg.from === mqttClientId && !packet.retain) return; 
            handleIncomingMessage(msg, topic);
        } catch (e) {
            console.error("[MQTT] Parse error:", e);
        }
    });
}

function mqttPublish(topic, msg, retain = false) {
    if (mqttClient && mqttConnected) {
        msg.from = mqttClientId;
        mqttClient.publish(topic, JSON.stringify(msg), { retain: retain });
        console.log("[MQTT] Sent to", topic, ":", msg.type);
    }
}

function updateMqttStatusUI(connected, detail) {
    const badge = document.getElementById('mqtt-status');
    if (!badge) return;
    if (connected) {
        badge.innerHTML = '🟢 已连接';
        badge.style.background = 'rgba(162,155,254,0.15)';
        badge.style.color = '#a29bfe';
    } else {
        badge.innerHTML = '🔴 ' + (detail || '未连接');
        badge.style.background = 'rgba(255,107,129,0.15)';
        badge.style.color = '#ff6b81';
    }
}

// --- Unified init ---
function initAllChannels() {
    initLocalChannel();
    initMQTT();
    
    if (currentRole === 'boy') {
        currentPoints = parseInt(SafeStorage.getItem('totalPoints') || '120');
        studyHistory = JSON.parse(SafeStorage.getItem('studyHistory') || '[]');
        rewardHistory = JSON.parse(SafeStorage.getItem('rewardHistory') || '[]');
        currentTimerState = SafeStorage.getItem('currentTimerState') || '休息中';
        document.getElementById('points-display').innerText = currentPoints;
        updateRemoteStatus(currentTimerState);
        setTimeout(() => renderDashboard(studyHistory, rewardHistory), 150);
    }
}

// --- Unified message handler ---
function handleIncomingMessage(msg, topic) {
    // Both roles can receive config updates
    if (msg.type === 'SYNC_CONFIG') {
        renderRewardsFromConfig(msg.rewards);
        return;
    }

    if (currentRole === 'girl') {
        if (msg.type === 'CHEER') {
            showToast("💌 守护者向你发送了：" + msg.action);
        } else if (msg.type === 'SYNC_DATA') {
            // Boy might have adjusted points
            currentPoints = msg.points;
            SafeStorage.setItem('totalPoints', currentPoints);
            document.getElementById('points-display').innerText = currentPoints;
            
            // Sync reward history (to handle boy fulfilling items)
            if (msg.rewardHistory) {
                rewardHistory = msg.rewardHistory;
                SafeStorage.setItem('rewardHistory', JSON.stringify(rewardHistory));
                if (typeof renderRewardHistoryUI === 'function') {
                    renderRewardHistoryUI(rewardHistory);
                }
            }

            if(msg.actionMsg) showToast(msg.actionMsg);
        }
    } else if (currentRole === 'boy') {
        if (msg.type === 'SYNC_DATA') {
            currentPoints = msg.points;
            studyHistory = msg.studyHistory;
            rewardHistory = msg.rewardHistory;
            currentTimerState = msg.status;
            
            SafeStorage.setItem('totalPoints', currentPoints);
            SafeStorage.setItem('studyHistory', JSON.stringify(studyHistory));
            SafeStorage.setItem('rewardHistory', JSON.stringify(rewardHistory));
            SafeStorage.setItem('currentTimerState', currentTimerState);
            
            document.getElementById('points-display').innerText = currentPoints;
            updateRemoteStatus(msg.status);
            renderDashboard(studyHistory, rewardHistory);
            
        } else if (msg.type === 'STATUS_CHANGE') {
            const oldBase = (currentTimerState || '').split('|')[0];
            const newBase = msg.status.split('|')[0];
            
            currentTimerState = msg.status;
            SafeStorage.setItem('currentTimerState', currentTimerState);
            updateRemoteStatus(msg.status);
            
            if (oldBase !== newBase) {
                showToast('💡 她的状态更新了：' + (msg.status.includes('studying') ? '正在学习' : msg.status.includes('paused') ? '暂停休息' : '结束学习'), 2000);
            }
        }
    }
}

// --- State Publishers (MQTT Retain) ---
function publishState(actionMsg = null) {
    const msg = {
        type: 'SYNC_DATA',
        points: currentPoints,
        studyHistory: studyHistory,
        rewardHistory: rewardHistory,
        status: currentTimerState,
        actionMsg: actionMsg
    };
    localBroadcast(msg);
    mqttPublish(TOPIC_STATE, msg, true); // RETAIN = TRUE
}

function publishConfig(rewardsArray) {
    const msg = {
        type: 'SYNC_CONFIG',
        rewards: rewardsArray
    };
    localBroadcast(msg);
    mqttPublish(TOPIC_CONFIG, msg, true); // RETAIN = TRUE
}

function broadcastEvent(msg) {
    localBroadcast(msg);
    mqttPublish(TOPIC_EVENTS, msg, false);
}

// --- Status updates ---
function broadcastStatus(statusName) {
    currentTimerState = statusName;
    SafeStorage.setItem('currentTimerState', statusName);
    if (currentRole === 'girl') {
        broadcastEvent({ type: 'STATUS_CHANGE', status: statusName });
    }
}

function updateRemoteStatus(statusStr) {
    const statusSpan = document.getElementById('remote-status');
    const pulse = document.querySelector('.pulse');
    if (!statusSpan || !pulse) return;
    
    if (statusStr && statusStr.startsWith('studying:')) {
        const parts = statusStr.split('|');
        let timeText = "";
        if (parts.length > 1) {
            const secs = parseInt(parts[1]);
            const m = Math.floor(secs / 60);
            const s = secs % 60;
            timeText = ` (已专注: ${m}分${s}秒)`;
        }
        statusSpan.innerText = "📝 正在拼命学习：" + parts[0].replace('studying: ', '') + timeText;
        pulse.style.animation = "breathe 1s infinite alternate";
        pulse.style.transform = "scale(1.2)";
    } else if (statusStr && statusStr.includes('paused')) {
        statusSpan.innerText = "⏸️ 暂时休息了一会儿...";
        pulse.style.animation = "breathe 2s infinite";
        pulse.style.transform = "scale(1)";
    } else {
        statusSpan.innerText = "目前在休息，等待学习开始...";
        pulse.style.animation = "breathe 2s infinite";
        pulse.style.transform = "scale(1)";
    }
}

// --- Toast notification (replaces alert for non-blocking feedback) ---
function showToast(text, duration) {
    duration = duration || 3000;
    var existing = document.getElementById('app-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.textContent = text;
    toast.style.cssText = 'position:fixed;top:30px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,0.95);color:#5c4b51;padding:14px 28px;border-radius:20px;font-size:1rem;z-index:99999;box-shadow:0 8px 30px rgba(0,0,0,0.12);border:1px solid rgba(255,183,197,0.3);backdrop-filter:blur(10px);animation:toastIn 0.3s ease;';
    document.body.appendChild(toast);
    setTimeout(function() {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(function() { toast.remove(); }, 300);
    }, duration);
}

// Inject toast animations
(function() {
    var style = document.createElement('style');
    style.textContent = '@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(-20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}@keyframes toastOut{from{opacity:1;transform:translateX(-50%) translateY(0)}to{opacity:0;transform:translateX(-50%) translateY(-20px)}}';
    document.head.appendChild(style);
})();


// ==========================================
// 3. Timer Logic (Girl Only)
// ==========================================

let timerInterval;
let secondsElapsed = 0;
let lastVerifiedSeconds = 0; // 新增：最后一次通过验证的秒数
let lastBroadcastTime = 0;
let isRunning = false;
let startTime;

// Quiz variables
let quizScheduleTimeout;
let quizActiveInterval;
let quizFails = 0;
const QUIZ_MIN_SEC = 5 * 60;  // 5 minutes (修改为正式时间)
const QUIZ_MAX_SEC = 10 * 60; // 10 minutes (修改为正式时间)

let originalTitle = document.title;
let titleFlashInterval;

function playDingSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1);
        oscillator.start(audioCtx.currentTime);
        oscillator.stop(audioCtx.currentTime + 1);
    } catch(e) { console.log("Audio not supported or blocked", e); }
}

const timeDisplay = document.getElementById('time-label');
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-btn');
const subjectSelect = document.getElementById('subject-select');

// Quiz Logic
function scheduleNextQuiz() {
    clearTimeout(quizScheduleTimeout);
    if (!isRunning) return;
    
    // Random between 8 and 15 seconds for testing
    const nextInterval = Math.floor(Math.random() * (QUIZ_MAX_SEC - QUIZ_MIN_SEC + 1) + QUIZ_MIN_SEC) * 1000;
    
    quizScheduleTimeout = setTimeout(() => {
        if (!isRunning) return;
        showQuiz();
    }, nextInterval);
}

function showQuiz() {
    document.getElementById('quiz-overlay').style.display = 'flex';
    
    let timeLeft = 30;
    document.getElementById('quiz-timer-sec').innerText = timeLeft;
    
    playDingSound();
    
    if ("Notification" in window && Notification.permission === "granted") {
        const notif = new Notification("⏰ 专注验证", {
            body: "快点击确认，证明你在认真学习！",
            icon: "./melody.png"
        });
        notif.onclick = function() {
            window.focus();
            document.getElementById('quiz-submit-btn').click();
            notif.close();
        };
    }
    
    clearInterval(titleFlashInterval);
    let flashOn = true;
    titleFlashInterval = setInterval(() => {
        document.title = flashOn ? "【⚠️请点击确认】" : originalTitle;
        flashOn = !flashOn;
    }, 500);
    
    clearInterval(quizActiveInterval);
    quizActiveInterval = setInterval(() => {
        timeLeft--;
        document.getElementById('quiz-timer-sec').innerText = timeLeft;
        if (timeLeft <= 0) {
            handleQuizFail();
        }
    }, 1000);
}

function stopAlerts() {
    clearInterval(titleFlashInterval);
    document.title = originalTitle;
}

function handleQuizFail() {
    clearInterval(quizActiveInterval);
    stopAlerts();
    document.getElementById('quiz-overlay').style.display = 'none';
    quizFails++;
    
    if (quizFails >= 2) {
        showToast('⚠️ 连续2次未响应验证，已强制结束并扣除10分！', 5000);
        broadcastEvent({ type: 'CHEER', action: '【系统警告】她连续2次未通过专注验证，已自动结束并扣分！' });
        
        // 惩罚1: 未经验证的时间全部作废
        secondsElapsed = lastVerifiedSeconds;
        
        // 惩罚2: 倒扣10分
        currentPoints -= 10;
        if (currentPoints < 0) currentPoints = 0;
        SafeStorage.setItem('totalPoints', currentPoints);
        document.getElementById('points-display').innerText = currentPoints;
        
        // 强制停止计时并结算
        stopBtn.click();
        
        // 同步给男生端 (带 retain)
        publishState('【防作弊系统】检测到恶意挂机，已作废无效时长并扣除 10 积分！');
        
        quizFails = 0;
    } else {
        showToast('⚠️ 未及时响应验证，已自动暂停专注！', 4000);
        broadcastEvent({ type: 'CHEER', action: '【系统提示】她未及时响应验证，专注已暂停！' });
        pauseBtn.click();
    }
}

document.getElementById('quiz-submit-btn').addEventListener('click', () => {
    clearInterval(quizActiveInterval);
    stopAlerts();
    document.getElementById('quiz-overlay').style.display = 'none';
    quizFails = 0;
    lastVerifiedSeconds = secondsElapsed; // 记录下当前通过验证的时间点
    showToast('✅ 验证通过，继续专注！', 2000);
    scheduleNextQuiz();
});

function updateDisplay() {
    const hrs = Math.floor(secondsElapsed / 3600).toString().padStart(2, '0');
    const mins = Math.floor((secondsElapsed % 3600) / 60).toString().padStart(2, '0');
    const secs = (secondsElapsed % 60).toString().padStart(2, '0');
    timeDisplay.innerText = hrs + ':' + mins + ':' + secs;
}

function saveTimerState() {
    if (currentRole !== 'girl') return;
    SafeStorage.setItem('girlTimerState', JSON.stringify({
        isRunning: isRunning,
        isPaused: !isRunning && secondsElapsed > 0,
        startTime: startTime,
        secondsElapsed: secondsElapsed,
        pausedAt: !isRunning ? Date.now() : null,
        subjectIndex: subjectSelect.selectedIndex
    }));
}

// Restore timer state on load (called from initRoleUI -> applyRoleConstraints)
function restoreTimerState() {
    if (currentRole !== 'girl') return;
    const savedStateStr = SafeStorage.getItem('girlTimerState');
    if (savedStateStr) {
        try {
            const savedState = JSON.parse(savedStateStr);
            if (savedState.subjectIndex !== undefined) {
                subjectSelect.selectedIndex = savedState.subjectIndex;
                _lastKnownSubject = subjectSelect.options[subjectSelect.selectedIndex].text;
            }
            if (savedState.isRunning && savedState.startTime) {
                // Was running when page closed — resume with correct elapsed time
                isRunning = true;
                startTime = Date.now() - (savedState.secondsElapsed * 1000);
                
                timerInterval = setInterval(timerTick, 1000);

                startBtn.classList.add('hidden');
                pauseBtn.classList.remove('hidden');
                stopBtn.classList.remove('hidden');
                updateDisplay();
                scheduleNextQuiz();
                
                const subjectName = subjectSelect.options[subjectSelect.selectedIndex].text;
                broadcastStatus('studying: ' + subjectName + '|' + secondsElapsed);
                showToast('⏰ 计时已恢复，继续专注！', 3000);
            } else if (savedState.secondsElapsed > 0) {
                // Was paused — restore paused state
                secondsElapsed = savedState.secondsElapsed;
                isRunning = false;
                startBtn.classList.remove('hidden');
                pauseBtn.classList.add('hidden');
                stopBtn.classList.remove('hidden');
                updateDisplay();
                showToast('⏸ 计时已恢复（暂停中），点击开始继续', 3000);
            }
        } catch(e) {
            console.error("Failed to restore timer state", e);
        }
    }
}
// NOTE: restoreTimerState() is called from applyRoleConstraints() after role is set

// Track previous subject name for switch handling
// Use a persistent variable that always holds the "current" subject before any switch
let _lastKnownSubject = subjectSelect.options[subjectSelect.selectedIndex].text;

function timerTick() {
    secondsElapsed = Math.floor((Date.now() - startTime) / 1000);
    updateDisplay();
    if (secondsElapsed - lastBroadcastTime >= 3) {
        lastBroadcastTime = secondsElapsed;
        const subjectName = subjectSelect.options[subjectSelect.selectedIndex].text;
        broadcastStatus('studying: ' + subjectName + '|' + secondsElapsed);
    }
}

// Bug #2 fix: Handle subject switch during active timer
subjectSelect.addEventListener('change', () => {
    if (currentRole !== 'girl') return;
    
    const prevSubjectName = _lastKnownSubject;
    // Update to the new subject immediately
    _lastKnownSubject = subjectSelect.options[subjectSelect.selectedIndex].text;
    
    if (!isRunning && secondsElapsed === 0) return; // Not timing, no action needed
    
    if (isRunning || secondsElapsed > 0) {
        // Auto-save current subject's time before switching
        const earnedMinutes = Math.floor(secondsElapsed / 60);
        if (earnedMinutes > 0) {
            currentPoints += earnedMinutes;
            SafeStorage.setItem('totalPoints', currentPoints);
            document.getElementById('points-display').innerText = currentPoints;
            
            studyHistory.unshift({
                subject: prevSubjectName,
                duration_minutes: earnedMinutes,
                created_at: new Date().toISOString()
            });
            // Truncate history to prevent localStorage exhaustion
            if (studyHistory.length > 500) studyHistory = studyHistory.slice(0, 500);
            SafeStorage.setItem('studyHistory', JSON.stringify(studyHistory));
            showToast('📝 已保存 ' + prevSubjectName + ' ' + earnedMinutes + ' 分钟，切换到新科目');
            publishState();
        } else {
            showToast('📝 切换科目，重新开始计时');
        }
        
        // Reset timer and restart for new subject
        clearInterval(timerInterval);
        secondsElapsed = 0;
        lastBroadcastTime = 0;
        lastVerifiedSeconds = 0; // 重置验证基准
        startTime = Date.now();
        updateDisplay();
        
        if (isRunning) {
            // Restart timer for new subject
            timerInterval = setInterval(timerTick, 1000);
            
            const newSubjectName = subjectSelect.options[subjectSelect.selectedIndex].text;
            broadcastStatus('studying: ' + newSubjectName + '|0');
        }
        saveTimerState();
    }
});

startBtn.addEventListener('click', () => {
    if (currentRole !== 'girl') return;
    if (isRunning) return;
    
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
        Notification.requestPermission();
    }
    
    isRunning = true;
    startTime = Date.now() - (secondsElapsed * 1000);
    lastVerifiedSeconds = secondsElapsed; // 启动/恢复时重置验证基准
    
    timerInterval = setInterval(() => {
        secondsElapsed = Math.floor((Date.now() - startTime) / 1000);
        updateDisplay();
        if (secondsElapsed % 3 === 0) {
            const subjectName = subjectSelect.options[subjectSelect.selectedIndex].text;
            broadcastStatus('studying: ' + subjectName + '|' + secondsElapsed);
        }
    }, 1000);

    startBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    stopBtn.classList.remove('hidden');

    const subjectName = subjectSelect.options[subjectSelect.selectedIndex].text;
    broadcastStatus('studying: ' + subjectName + '|0');
    showToast('📚 开始专注！加油！');
    saveTimerState();
    scheduleNextQuiz();
});

pauseBtn.addEventListener('click', () => {
    if (currentRole !== 'girl') return;
    isRunning = false;
    clearInterval(timerInterval);
    
    startBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    
    broadcastStatus('paused');
    showToast('⏸️ 暂停中，休息一下~');
    saveTimerState();
    stopAlerts();
    clearTimeout(quizScheduleTimeout);
    clearInterval(quizActiveInterval);
    document.getElementById('quiz-overlay').style.display = 'none';
});

stopBtn.addEventListener('click', () => {
    if (currentRole !== 'girl') return;
    if (secondsElapsed === 0) return;
    
    isRunning = false;
    clearInterval(timerInterval);
    
    const earnedPoints = Math.floor(secondsElapsed / 60);
    if (earnedPoints > 0) {
        currentPoints += earnedPoints;
        SafeStorage.setItem('totalPoints', currentPoints);
        document.getElementById('points-display').innerText = currentPoints;
        
        // Save to study_history
        const subjectName = subjectSelect.options[subjectSelect.selectedIndex].text;
        studyHistory.unshift({
            subject: subjectName,
            duration_minutes: earnedPoints,
            created_at: new Date().toISOString()
        });
        SafeStorage.setItem('studyHistory', JSON.stringify(studyHistory));
        
        showToast('真棒！本次专注获得 ' + earnedPoints + ' 积分！');
        
        // 同步给男生
        publishState();
    }
    
    secondsElapsed = 0;
    updateDisplay();
    
    startBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    stopBtn.classList.add('hidden');
    
    broadcastStatus('stopped');
    SafeStorage.removeItem('girlTimerState');
    stopAlerts();
    clearTimeout(quizScheduleTimeout);
    clearInterval(quizActiveInterval);
    document.getElementById('quiz-overlay').style.display = 'none';
});


// ==========================================
// 4. Rewards Logic
// ==========================================
let currentRewardsConfig = JSON.parse(SafeStorage.getItem('rewardsConfig') || '[]');
if (currentRewardsConfig.length === 0) {
    currentRewardsConfig = [];
}

function renderRewardsFromConfig(rewardsArray) {
    currentRewardsConfig = rewardsArray;
    SafeStorage.setItem('rewardsConfig', JSON.stringify(rewardsArray));
    
    const grid = document.querySelector('.rewards-grid');
    if (!grid) return;
    
    grid.innerHTML = '';
    rewardsArray.forEach(reward => {
        let iconHtml = reward.icon;
        
        // Parse markdown image: ![alt](url)
        const mdMatch = reward.icon.match(/!\[.*?\]\((.*?)\)/);
        let iconUrl = mdMatch ? mdMatch[1] : null;
        
        // Or direct URL
        if (!iconUrl && (reward.icon.startsWith('http') || reward.icon.startsWith('data:image') || reward.icon.startsWith('/'))) {
            iconUrl = reward.icon;
        }

        if (iconUrl) {
            iconHtml = `<img src="${iconUrl}" style="max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px;">`;
        }

        const div = document.createElement('div');
        div.className = 'reward-card glass';
        const safeName = document.createElement('div');
        safeName.textContent = reward.name;
        
        let btnHtml = '';
        if (currentRole === 'boy') {
            btnHtml = `<button class="btn delete-btn sm" style="background: rgba(255,107,129,0.1); color: #ff6b81; border: 1px solid #ff6b81; margin-top:10px;">🗑️ 下架奖品</button>`;
        } else {
            btnHtml = `<button class="btn primary glass-btn sm redeem-btn">兑换</button>`;
        }

        div.innerHTML = `
            <div class="reward-icon" style="display:flex; align-items:center; justify-content:center; height: 80px; margin-bottom: 10px;">${iconHtml}</div>
            <h3>${safeName.innerHTML}</h3>
            <p>${reward.cost} 积分</p>
            ${btnHtml}
        `;
        
        const actionBtn = div.querySelector('button');
        actionBtn.addEventListener('click', () => {
            if (currentRole === 'boy') {
                // 下架逻辑
                if (confirm('确定要下架奖品【' + reward.name + '】吗？')) {
                    currentRewardsConfig = currentRewardsConfig.filter(r => r.name !== reward.name);
                    SafeStorage.setItem('rewardsConfig', JSON.stringify(currentRewardsConfig));
                    renderRewardsFromConfig(currentRewardsConfig);
                    publishConfig(currentRewardsConfig);
                    showToast('🗑️ 已成功下架：' + reward.name);
                }
                return;
            }
            
            // 兑换逻辑 (Girls only)
            if (currentRole !== 'girl') {
                showToast('只有女孩才能兑换奖励哦！');
                return;
            }
            if (currentPoints >= reward.cost) {
                currentPoints -= reward.cost;
                SafeStorage.setItem('totalPoints', currentPoints);
                document.getElementById('points-display').innerText = currentPoints;
                
                rewardHistory.unshift({
                    id: Date.now(),
                    reward_name: reward.name,
                    cost: reward.cost,
                    created_at: new Date().toISOString(),
                    fulfilled: false
                });
                SafeStorage.setItem('rewardHistory', JSON.stringify(rewardHistory));
                
                showToast('🎉 兑换成功！已经放入小金库等待他兑现啦~');
                
                // Update local UI immediately for girl
                if (typeof renderRewardHistoryUI === 'function') {
                    renderRewardHistoryUI(rewardHistory);
                }
                
                // 同步给男生 (带 retain)
                publishState('【兑换通知】她刚刚兑换了心愿：' + reward.name);
            } else {
                showToast('❌ 积分不足，快去学习赚积分吧！');
            }
        });
        grid.appendChild(div);
    });
}

// Initial render
renderRewardsFromConfig(currentRewardsConfig);


// ==========================================
// 5. Dashboard Charts & Boy Logic
// ==========================================
let barChartInstance = null;
let horizontalBarChartInstance = null;

function renderDashboard(sHistory, rHistory) {
    if (typeof Chart === 'undefined') {
        console.warn("Chart.js not loaded, skipping dashboard render");
        return;
    }
    
    // --- 1. Calculate Stats ---
    // Bug #5 fix: use proper date normalization without mutating Date objects
    const todayDate = new Date();
    const todayTime = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate()).getTime();
    let todayMinutes = 0;
    let totalMinutes = 0;
    const daysStudied = new Set();
    
    sHistory.forEach(row => {
        const rowDate = new Date(row.created_at);
        const rowTime = new Date(rowDate.getFullYear(), rowDate.getMonth(), rowDate.getDate()).getTime();
        if (rowTime === todayTime) {
            todayMinutes += row.duration_minutes;
        }
        totalMinutes += row.duration_minutes;
        daysStudied.add(rowTime);
    });
    
    // Bug #5 fix: correct streak calculation
    let streak = 0;
    // Start from today; if no study today, start from yesterday
    let startDay = daysStudied.has(todayTime) ? 0 : 1;
    for (let i = startDay; i < 60; i++) {
        const d = todayTime - i * 86400000;
        if (daysStudied.has(d)) {
            streak++;
        } else {
            break;
        }
    }
    
    // Bug #4 fix: Avg rating from review history array
    let avgRating = 0;
    try {
        const reviewHistory = JSON.parse(SafeStorage.getItem('reviewHistory') || '[]');
        if (reviewHistory.length > 0) {
            const sum = reviewHistory.reduce((acc, r) => acc + (r.rating || 0), 0);
            avgRating = (sum / reviewHistory.length).toFixed(1);
        }
    } catch(e) {}

    // Update stat elements
    const eToday = document.getElementById('stat-today');
    const eStreak = document.getElementById('stat-streak');
    const eTotal = document.getElementById('stat-total');
    const eAvg = document.getElementById('stat-avg');
    
    if (eToday) eToday.innerHTML = todayMinutes + '<span style="font-size: 0.9rem; color: var(--text-secondary);">分</span>';
    if (eStreak) eStreak.innerHTML = streak + '<span style="font-size: 0.9rem; color: var(--text-secondary);">天</span>';
    if (eTotal) eTotal.innerHTML = (totalMinutes / 60).toFixed(1) + '<span style="font-size: 0.9rem; color: var(--text-secondary);">时</span>';
    if (eAvg) eAvg.innerHTML = avgRating + '<span style="font-size: 0.9rem; color: var(--text-secondary);">分</span>';

    // --- 2. Render Charts ---
    const barCtx = document.getElementById('barChart');
    const hBarCtx = document.getElementById('horizontalBarChart');
    if (!barCtx || !hBarCtx) return;

    const colors = ['#ffb7c5', '#a29bfe', '#74b9ff', '#55efc4', '#ffe6f2', '#dfe6e9'];
    const subjectNames = [...new Set(sHistory.map(r => r.subject))];

    // Weekly Stacked Bar Chart
    const last7Days = Array.from({length: 7}, (_, i) => {
        const d = new Date(Date.now() - (6 - i) * 86400000);
        return { date: d, label: d.toLocaleDateString('zh-CN', {weekday: 'short'}), time: d.setHours(0,0,0,0) };
    });
    
    const datasetsBar = subjectNames.map((subj, idx) => {
        return {
            label: subj,
            backgroundColor: colors[idx % colors.length],
            borderRadius: 6,
            maxBarThickness: 40,
            data: last7Days.map(day => {
                return sHistory
                    .filter(r => r.subject === subj && new Date(r.created_at).setHours(0,0,0,0) === day.time)
                    .reduce((sum, r) => sum + r.duration_minutes, 0);
            })
        };
    });

    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(barCtx, {
        type: 'bar',
        data: {
            labels: last7Days.map(d => d.label),
            datasets: datasetsBar.length ? datasetsBar : [{ label: '暂无数据', data: [0,0,0,0,0,0,0], backgroundColor: '#dfe6e9', maxBarThickness: 40, borderRadius: 6 }]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                x: { 
                    stacked: true, 
                    grid: { display: false },
                    border: { display: false }
                },
                y: { 
                    stacked: true, 
                    beginAtZero: true, 
                    border: { display: false },
                    grid: { color: 'rgba(0, 0, 0, 0.04)' },
                    ticks: { precision: 0, stepSize: 1, color: '#a0a0a0' }
                }
            },
            plugins: {
                legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, padding: 20, font: { family: "'Nunito', sans-serif" } } },
                tooltip: { backgroundColor: 'rgba(255, 255, 255, 0.9)', titleColor: '#5c4b51', bodyColor: '#5c4b51', borderColor: 'rgba(255,183,197,0.3)', borderWidth: 1, padding: 10, cornerRadius: 8, displayColors: true, usePointStyle: true }
            }
        }
    });

    // Horizontal Bar Chart
    const subjectTotals = {};
    sHistory.forEach(row => {
        if (!subjectTotals[row.subject]) subjectTotals[row.subject] = 0;
        subjectTotals[row.subject] += row.duration_minutes;
    });
    const hLabels = Object.keys(subjectTotals);
    const hData = Object.values(subjectTotals);

    if (horizontalBarChartInstance) horizontalBarChartInstance.destroy();
    horizontalBarChartInstance = new Chart(hBarCtx, {
        type: 'bar',
        data: {
            labels: hLabels.length ? hLabels : ['暂无数据'],
            datasets: [{
                label: '累计时长 (分钟)',
                data: hData.length ? hData : [0],
                backgroundColor: hLabels.length ? hLabels.map((_, i) => colors[i % colors.length]) : ['#dfe6e9'],
                borderRadius: 6,
                maxBarThickness: 30
            }]
        },
        options: { 
            indexAxis: 'y',
            responsive: true, 
            maintainAspectRatio: false,
            plugins: { 
                legend: { display: false },
                tooltip: { backgroundColor: 'rgba(255, 255, 255, 0.9)', titleColor: '#5c4b51', bodyColor: '#5c4b51', borderColor: 'rgba(255,183,197,0.3)', borderWidth: 1, padding: 10, cornerRadius: 8, displayColors: true, usePointStyle: true }
            },
            scales: {
                x: { 
                    beginAtZero: true, 
                    border: { display: false },
                    grid: { color: 'rgba(0, 0, 0, 0.04)' },
                    ticks: { precision: 0, stepSize: 1, color: '#a0a0a0' }
                },
                y: { 
                    grid: { display: false },
                    border: { display: false },
                    ticks: { color: '#a0a0a0' }
                }
            }
        }
    });

    // Update reward history list for both Boy and Girl
    renderRewardHistoryUI(rHistory);
}

function renderRewardHistoryUI(rHistory) {
    const boyList = document.getElementById('reward-history-list');
    const girlList = document.getElementById('girl-reward-history-list');
    if (!boyList) return;
    
    boyList.innerHTML = '';
    if (girlList) girlList.innerHTML = '';
    
    let hasPending = false;

    rHistory.forEach(row => {
        if (!row.fulfilled) {
            hasPending = true;
            const date = new Date(row.created_at).toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
            
            const liBoy = document.createElement('li');
            liBoy.style.cssText = "padding: 10px 0; border-bottom: 1px dashed rgba(0,0,0,0.1); display:flex; justify-content:space-between; align-items:center;";
            liBoy.innerHTML = `
                <div><span style="color:var(--danger);">[${date}]</span> 🎁 <strong>${row.reward_name}</strong></div>
                <button class="btn primary sm" style="padding: 5px 15px; font-size: 0.85rem;" onclick="fulfillReward('${row.created_at}')">✔️ 满足她</button>
            `;
            boyList.appendChild(liBoy);
            
            if (girlList) {
                const liGirl = document.createElement('li');
                liGirl.style.cssText = "padding: 10px 0; border-bottom: 1px dashed rgba(0,0,0,0.1);";
                liGirl.innerHTML = `<span style="color:var(--danger);">[${date}]</span> 🎁 <strong>${row.reward_name}</strong> <span style="font-size:0.85rem; color:#6c5ce7; float:right; background:rgba(108,92,231,0.1); padding:2px 8px; border-radius:10px;">⌛ 待他兑现</span>`;
                girlList.appendChild(liGirl);
            }
        }
    });

    if (!hasPending) {
        boyList.innerHTML = '<li style="padding: 10px 0; border-bottom: 1px dashed rgba(0,0,0,0.1);">暂无待满足的心愿</li>';
        if (girlList) girlList.innerHTML = '<li style="padding: 10px 0; border-bottom: 1px dashed rgba(0,0,0,0.1);">空空如也，快去兑换吧！</li>';
    }
}

window.fulfillReward = function(createdAt) {
    if (currentRole !== 'boy') return;
    const idx = rewardHistory.findIndex(r => r.created_at === createdAt);
    if (idx !== -1) {
        const rewardName = rewardHistory[idx].reward_name;
        rewardHistory.splice(idx, 1); // 满足后直接从列表消除
        SafeStorage.setItem('rewardHistory', JSON.stringify(rewardHistory));
        publishState('💖 已满足她的心愿：' + rewardName);
        renderRewardHistoryUI(rewardHistory);
        showToast('已标记为满足！');
    }
}

// Cheer Buttons (Boy)
document.querySelectorAll('.cheer-btns button').forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (currentRole !== 'boy') return;
        const actionText = e.target.innerText;
        broadcastEvent({ type: 'CHEER', action: actionText });
        showToast("发送成功！");
    });
});

const customCheerBtn = document.getElementById('custom-cheer-btn');
if (customCheerBtn) {
    customCheerBtn.addEventListener('click', () => {
        if (currentRole !== 'boy') return;
        const input = document.getElementById('custom-cheer-input');
        const text = input.value.trim();
        if (!text) {
            showToast('鼓励语不能为空哦~');
            return;
        }
        broadcastEvent({ type: 'CHEER', action: '💌 ' + text });
        showToast("发送成功！");
        input.value = '';
    });
}


// ==========================================
// 6. Navigation Logic
// ==========================================
const navBtns = document.querySelectorAll('.nav-btn');
const views = document.querySelectorAll('.view-section');

// Bug #8 fix: proper view switch without race conditions
let viewSwitchTimeout = null;
navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        if (!targetId) return;
        
        navBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Clear any pending switch
        if (viewSwitchTimeout) clearTimeout(viewSwitchTimeout);
        
        views.forEach(view => {
            if (view.id === targetId) {
                view.classList.remove('hidden');
                view.style.opacity = '1';
                view.style.pointerEvents = 'auto';
            } else {
                view.style.opacity = '0';
                view.style.pointerEvents = 'none';
                // Use a single timeout reference to prevent race conditions
                const viewRef = view;
                viewSwitchTimeout = setTimeout(() => {
                    viewRef.classList.add('hidden');
                }, 300);
            }
        });
        
        // Bug #7 fix: render charts when dashboard becomes visible
        if (targetId === 'dashboard-view' && currentRole === 'boy') {
            // Re-read from localStorage (in case girl updated it in another tab)
            currentPoints = parseInt(SafeStorage.getItem('totalPoints') || '120');
            studyHistory = JSON.parse(SafeStorage.getItem('studyHistory') || '[]');
            rewardHistory = JSON.parse(SafeStorage.getItem('rewardHistory') || '[]');
            currentTimerState = SafeStorage.getItem('currentTimerState') || '休息中';
            document.getElementById('points-display').innerText = currentPoints;
            updateRemoteStatus(currentTimerState);
            // Delay chart rendering slightly to ensure canvas is visible
            setTimeout(() => {
                renderDashboard(studyHistory, rewardHistory);
            }, 100);
            
            broadcastEvent({ type: 'REQ_SYNC' });
        }
    });
});

// ==========================================
// 7. Star Rating Logic
// ==========================================
const stars = document.querySelectorAll('.star');
let currentRating = 0;

stars.forEach(star => {
    star.addEventListener('click', () => {
        currentRating = parseInt(star.getAttribute('data-value'));
        stars.forEach(s => {
            if (parseInt(s.getAttribute('data-value')) <= currentRating) {
                s.classList.add('active');
            } else {
                s.classList.remove('active');
            }
        });
    });
});

// Bug #4 fix: Save review to history array instead of overwriting
const saveReviewBtn = document.querySelector('#summary-view .btn.primary');
if (saveReviewBtn) {
    saveReviewBtn.addEventListener('click', () => {
        const note = document.getElementById('daily-note').value;
        if (currentRating === 0) {
            showToast('请先给自己打个分吧~');
            return;
        }
        
        // Load existing review history or create new array
        let reviewHistory = [];
        try {
            reviewHistory = JSON.parse(SafeStorage.getItem('reviewHistory') || '[]');
        } catch(e) { reviewHistory = []; }
        
        reviewHistory.unshift({
            rating: currentRating,
            note: note,
            date: new Date().toISOString()
        });
        
        // Keep last 90 days of reviews
        if (reviewHistory.length > 90) reviewHistory = reviewHistory.slice(0, 90);
        
        SafeStorage.setItem('reviewHistory', JSON.stringify(reviewHistory));
        // Also keep lastReview for backward compatibility
        SafeStorage.setItem('lastReview', JSON.stringify({
            rating: currentRating,
            note: note,
            date: new Date().toISOString()
        }));
        
        showToast('✅ 复盘已保存！明天继续加油~');
        if (currentRole === 'girl') {
            publishState();
        }
        
        // Reset form
        currentRating = 0;
        stars.forEach(s => s.classList.remove('active'));
        document.getElementById('daily-note').value = '';
    });
}

// ==========================================
// 8. Guardian Admin Logic (Boy Only)
// ==========================================
const adminPointBtn = document.getElementById('admin-point-btn');
if (adminPointBtn) {
    adminPointBtn.addEventListener('click', () => {
        if (currentRole !== 'boy') return;
        const deltaInput = document.getElementById('admin-point-delta');
        const delta = parseInt(deltaInput.value);
        if (isNaN(delta) || delta === 0) {
            showToast('请输入有效的调整分数值！');
            return;
        }
        
        currentPoints += delta;
        if (currentPoints < 0) currentPoints = 0;
        
        SafeStorage.setItem('totalPoints', currentPoints);
        document.getElementById('points-display').innerText = currentPoints;
        deltaInput.value = '';
        
        const actionMsg = delta > 0 ? ('【奖励】守护者为你增加了 ' + delta + ' 积分！') : ('【惩罚】守护者扣除了你 ' + Math.abs(delta) + ' 积分！');
        showToast('✅ 积分调整成功！');
        
        // 强制发布新状态覆盖云端
        publishState(actionMsg);
    });
}

const adminRewardBtn = document.getElementById('admin-reward-btn');

// 支持直接粘贴截图/图片文件，自动压缩为 Base64
const adminRewardIconInput = document.getElementById('admin-reward-icon');
if (adminRewardIconInput) {
    adminRewardIconInput.addEventListener('paste', function(e) {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let index in items) {
            const item = items[index];
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                const reader = new FileReader();
                reader.onload = function(event) {
                    const img = new Image();
                    img.onload = function() {
                        // 压缩图片到最大 200px
                        const canvas = document.createElement('canvas');
                        const MAX_SIZE = 200;
                        let width = img.width;
                        let height = img.height;
                        if (width > height) {
                            if (width > MAX_SIZE) {
                                height *= MAX_SIZE / width;
                                width = MAX_SIZE;
                            }
                        } else {
                            if (height > MAX_SIZE) {
                                width *= MAX_SIZE / height;
                                height = MAX_SIZE;
                            }
                        }
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                        adminRewardIconInput.value = dataUrl;
                        showToast('🖼️ 图片粘贴成功！已自动压缩。');
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(blob);
                return; // 只要处理了一张图片就返回
            }
        }
    });
}

if (adminRewardBtn) {
    adminRewardBtn.addEventListener('click', () => {
        if (currentRole !== 'boy') return;
        const icon = document.getElementById('admin-reward-icon').value.trim() || '🎁';
        const name = document.getElementById('admin-reward-name').value.trim();
        const cost = parseInt(document.getElementById('admin-reward-cost').value);
        
        if (!name || isNaN(cost) || cost <= 0) {
            showToast('请填写完整的奖品名称和所需积分！');
            return;
        }
        
        const existingIndex = currentRewardsConfig.findIndex(r => r.name === name);
        if (existingIndex >= 0) {
            currentRewardsConfig[existingIndex].icon = icon;
            currentRewardsConfig[existingIndex].cost = cost;
            showToast('✅ 已更新现有奖品：' + name);
        } else {
            currentRewardsConfig.push({ name: name, icon: icon, cost: cost });
            showToast('✅ 成功上架新奖品：' + name);
        }
        
        document.getElementById('admin-reward-name').value = '';
        document.getElementById('admin-reward-cost').value = '';
        
        // 发布 Config 覆盖云端
        publishConfig(currentRewardsConfig);
    });
}

// Run Init
console.log("Running Init...");
try {
    initRoleUI();
    console.log("Init finished without errors");
} catch (e) {
    console.error("Error during Init:", e);
    showToast("初始化错误: " + e.message);
}
