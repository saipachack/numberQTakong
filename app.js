// ==========================================
// SNAP & GLOW Queue Management Script
// ==========================================

// Global state
let state = {
    queue: [],
    ticketCounter: 1,
    avgWaitTimePerPerson: 5 // minutes
};

// Web Speech Synthesis
const synth = window.speechSynthesis;
let availableVoices = [];
let isUpdatingNetwork = false;
let lastWriteTime = 0;
let cloudRoomId = localStorage.getItem('snap_glow_cloud_room_id') || '';
let isCloudSyncActive = localStorage.getItem('snap_glow_cloud_sync_active') === 'true';

// Device Presence State
const myDeviceId = 'dev_' + Math.random().toString(36).substring(2, 9);
let activeDevicesCount = 1;

// Initialize application
document.addEventListener("DOMContentLoaded", () => {
    // Initialize icons
    lucide.createIcons();
    
    // Load state from server initially, fallback to local storage
    loadStateFromServer();
    
    // Poll server every 1.2s for real-time queue updates across other devices
    setInterval(loadStateFromServer, 1200);

    // Start device presence syncing
    syncDevicePresence();
    setInterval(syncDevicePresence, 4000);
    // Set up local storage listener for multi-window sync
    window.addEventListener('storage', (e) => {
        if (e.key === 'snap_glow_queue_state') {
            loadStateFromStorage();
            renderAll();
        }
    });

    // Populate voice selections for Operator panel
    setupSpeechVoices();
    if (synth && synth.onvoiceschanged !== undefined) {
        synth.onvoiceschanged = setupSpeechVoices;
    }

    // Initialize Cloud Sync inputs & states
    updateCloudUI();

    // Default step initialization
    goToStep('welcome');

    // Initial render
    renderAll();
});

// Load/Save State
function validateState(data) {
    if (data && Array.isArray(data.queue)) {
        if (typeof data.ticketCounter !== 'number') {
            let maxNum = 1;
            data.queue.forEach(item => {
                if (item && item.number) {
                    const match = item.number.match(/\d+/);
                    if (match) {
                        const num = parseInt(match[0], 10);
                        if (num >= maxNum) maxNum = num + 1;
                    }
                }
            });
            data.ticketCounter = maxNum;
        }
        if (typeof data.avgWaitTimePerPerson !== 'number') {
            data.avgWaitTimePerPerson = 5;
        }
        return true;
    }
    return false;
}

function loadStateFromStorage() {
    const savedState = localStorage.getItem('snap_glow_queue_state');
    if (savedState) {
        try {
            const parsed = JSON.parse(savedState);
            if (validateState(parsed)) {
                state = parsed;
            } else {
                console.warn("Invalid state format in localStorage, resetting");
                resetState();
            }
        } catch (e) {
            console.error("Failed to parse queue state from localStorage", e);
            resetState();
        }
    } else {
        resetState();
    }
}

function loadStateFromServer() {
    if (isCloudSyncActive && cloudRoomId) {
        const fetchStartTime = Date.now();
        // Fetch from keyvalue.immanuel.co
        fetch(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/yzqkpawz/${cloudRoomId}?t=${Date.now()}`)
            .then(res => {
                if (!res.ok) throw new Error("Cloud fetch failed");
                return res.json();
            })
            .then(val => {
                if (!val) return;
                let data;
                try {
                    const decoded = safeDecode(val);
                    const parsed = JSON.parse(decoded);
                    if (parsed && (parsed.q || parsed.queue)) {
                        data = parsed.q ? decompressState(parsed) : parsed;
                    }
                } catch (e) {
                    try {
                        data = JSON.parse(hexToString(val));
                    } catch (e2) {
                        try {
                            data = JSON.parse(decodeURIComponent(val));
                        } catch (e3) {
                            try {
                                data = JSON.parse(val);
                            } catch (e4) {
                                return;
                            }
                        }
                    }
                }
                if (!isUpdatingNetwork && fetchStartTime >= lastWriteTime) {
                    if (validateState(data)) {
                        const serverWaitingAndCalling = data.queue.filter(item => item.status === 'waiting' || item.status === 'calling');
                        const localCompletedOrSkipped = state.queue.filter(item => item.status === 'completed' || item.status === 'skipped');
                        const mergedQueue = [...serverWaitingAndCalling, ...localCompletedOrSkipped];
                        const mergedState = {
                            queue: mergedQueue,
                            ticketCounter: Math.max(state.ticketCounter, data.ticketCounter),
                            avgWaitTimePerPerson: data.avgWaitTimePerPerson || 5
                        };
                        if (JSON.stringify(state) !== JSON.stringify(mergedState)) {
                            state = mergedState;
                            localStorage.setItem('snap_glow_queue_state', JSON.stringify(state));
                            renderAll();
                        }
                    }
                }
            })
            .catch(err => {
                loadStateFromStorage();
            });
    } else {
        const fetchStartTime = Date.now();
        // Fetch from local python server
        fetch('/api/state')
            .then(res => {
                if (!res.ok) throw new Error("Server error");
                return res.json();
            })
            .then(data => {
                if (!isUpdatingNetwork && fetchStartTime >= lastWriteTime) {
                    if (validateState(data) && JSON.stringify(state) !== JSON.stringify(data)) {
                        state = data;
                        localStorage.setItem('snap_glow_queue_state', JSON.stringify(state));
                        renderAll();
                    }
                }
            })
            .catch(err => {
                loadStateFromStorage();
            });
    }
}

function saveStateToStorage() {
    localStorage.setItem('snap_glow_queue_state', JSON.stringify(state));
    renderAll();
    
    isUpdatingNetwork = true;
    
    if (isCloudSyncActive && cloudRoomId) {
        const trimmedState = getTrimmedState();
        const compressed = compressState(trimmedState);
        const valueToSend = safeEncode(JSON.stringify(compressed));
        // Write to keyvalue.immanuel.co
        fetch(`https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/yzqkpawz/${cloudRoomId}/${valueToSend}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=1'
        })
        .then(res => {
            if (!res.ok) throw new Error("Cloud write failed");
            return res.json();
        })
        .then(data => {
            isUpdatingNetwork = false;
            lastWriteTime = Date.now();
        })
        .catch(err => {
            console.error("Failed to sync queue state to cloud:", err);
            isUpdatingNetwork = false;
            lastWriteTime = Date.now();
        });
    } else {
        // Write to local python server
        fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(state)
        })
        .then(res => {
            if (!res.ok) throw new Error("Server write failed");
            return res.json();
        })
        .then(data => {
            isUpdatingNetwork = false;
            lastWriteTime = Date.now();
        })
        .catch(err => {
            console.error("Failed to sync queue state to server:", err);
            isUpdatingNetwork = false;
            lastWriteTime = Date.now();
        });
    }
}

function resetState() {
    state = {
        queue: [],
        ticketCounter: 1,
        avgWaitTimePerPerson: 5
    };
    saveStateToStorage();
}

function getTrimmedState() {
    if (!state.queue) {
        return {
            queue: [],
            ticketCounter: state.ticketCounter,
            avgWaitTimePerPerson: state.avgWaitTimePerPerson
        };
    }
    const waitingAndCalling = state.queue.filter(item => item.status === 'waiting' || item.status === 'calling');
    const completedOrSkipped = state.queue.filter(item => item.status === 'completed' || item.status === 'skipped');
    
    // Sort completed/skipped by time descending
    completedOrSkipped.sort((a, b) => b.rawTime - a.rawTime);
    
    // Keep only the most recent completed/skipped items (say 5 items)
    const trimmedCompletedOrSkipped = completedOrSkipped.slice(0, 5);
    
    // Combine
    const trimmedQueue = [...waitingAndCalling, ...trimmedCompletedOrSkipped];
    
    return {
        queue: trimmedQueue,
        ticketCounter: state.ticketCounter,
        avgWaitTimePerPerson: state.avgWaitTimePerPerson
    };
}

// UI Navigation / View Switching
function switchRole(role) {
    document.querySelectorAll('.role-view').forEach(view => {
        view.classList.remove('active-view');
    });
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const viewId = `view-${role}`;
    const btnId = `btn-${role}`;
    
    document.getElementById(viewId).classList.add('active-view');
    document.getElementById(btnId).classList.add('active');
    
    if (role === 'kiosk') {
        goToStep('welcome');
    }
    

    
    // Re-render because TV view or operator view might have changed
    renderAll();
}

// -------------------------------------------------------------
// KIOSK REGISTRATION LOGIC
// -------------------------------------------------------------
function submitTicket() {
    const prefix = 'Q';
    const formattedNumber = `${prefix}-${String(state.ticketCounter).padStart(3, '0')}`;
    const timestampString = new Date().toLocaleTimeString('lo-LA', { hour: '2-digit', minute: '2-digit' });
    
    const newQueueItem = {
        id: 'q_' + Date.now(),
        number: formattedNumber,
        status: 'waiting',
        timestamp: timestampString,
        rawTime: Date.now()
    };
    
    state.queue.push(newQueueItem);
    state.ticketCounter += 1;
    saveStateToStorage();
    
    // Calculate Wait Time
    const waitingItems = state.queue.filter(item => item.status === 'waiting');
    const waitTime = (waitingItems.length - 1) * state.avgWaitTimePerPerson;
    
    // Populate Ticket Details
    document.getElementById('ticket-display-number').textContent = formattedNumber;
    document.getElementById('ticket-display-wait').textContent = waitTime > 0 ? `${waitTime} ນາທີ` : "ພ້ອມຖ່າຍທັນທີ";
    
    // Play ticket generate beep
    playTicketBeep();
    
    // Go to Ticket Step
    goToStep('ticket');
    

}

function playTicketBeep() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
    } catch(e) {}
}



function goToStep(step) {
    document.querySelectorAll('.step-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    if (step === 'welcome') {
        document.getElementById('step-welcome').classList.remove('hidden');
    } else if (step === 'ticket') {
        document.getElementById('step-ticket').classList.remove('hidden');
    }
}

function restartKiosk() {
    goToStep('welcome');
}

// -------------------------------------------------------------
// SOUND CHIME GENERATOR (Web Audio API)
// -------------------------------------------------------------
function playNotificationChime(callback) {
    if (!document.getElementById('chime-toggle').checked) {
        if (callback) callback();
        return;
    }
    
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        
        const notes = [587.33, 659.25, 880.00]; // D5, E5, A5
        const timing = [0, 0.15, 0.3];
        
        notes.forEach((freq, index) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + timing[index]);
            
            gain.gain.setValueAtTime(0, ctx.currentTime + timing[index]);
            gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + timing[index] + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + timing[index] + 0.6);
            
            osc.connect(gain);
            gain.connect(ctx.destination);
            
            osc.start(ctx.currentTime + timing[index]);
            osc.stop(ctx.currentTime + timing[index] + 0.6);
        });
        
        setTimeout(() => {
            if (callback) callback();
        }, 800);
        
    } catch (e) {
        console.error("Web Audio API blocked or not supported", e);
        if (callback) callback();
    }
}

// -------------------------------------------------------------
// VOICE ANNOUNCEMENT ENGINE (TTS)
// -------------------------------------------------------------
function setupSpeechVoices() {
    if (!synth) return;
    
    availableVoices = synth.getVoices();
    const select = document.getElementById('voice-select');
    if (!select) return;
    
    select.innerHTML = '';
    
    const defOpt = document.createElement('option');
    defOpt.value = 'default';
    defOpt.textContent = 'ສຽງລະບົບຫຼັກ (Default System Voice)';
    select.appendChild(defOpt);
    
    availableVoices.forEach((voice, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${voice.name} (${voice.lang})`;
        if (voice.lang.includes('th-TH') || voice.lang.includes('lo-LA')) {
            option.selected = true;
        }
        select.appendChild(option);
    });
}

function speakTicket(ticketNumber) {
    if (!synth) return;
    
    synth.cancel();
    
    const parts = ticketNumber.split('-');
    const letter = parts[0];
    const digits = parts[1].split('').join(' ');
    
    const select = document.getElementById('voice-select');
    let selectedVoiceIndex = select ? select.value : 'default';
    
    let announcementText = "";
    let isThaiLao = false;
    
    let chosenVoice = null;
    if (selectedVoiceIndex !== 'default') {
        chosenVoice = availableVoices[parseInt(selectedVoiceIndex)];
    } else {
        chosenVoice = availableVoices.find(v => v.lang.includes('th') || v.lang.includes('lo'));
    }
    
    if (chosenVoice && (chosenVoice.lang.includes('th') || chosenVoice.lang.includes('lo'))) {
        isThaiLao = true;
    }
    
    if (isThaiLao) {
        announcementText = `ขอเชิญหมายเลขคิว ${letter} ${digits} ที่ห้องถ่ายภาพค่ะ`;
    } else {
        announcementText = `Now calling ticket number ${letter}, ${digits}. Please proceed to the photobooth.`;
    }
    
    const utterance = new SpeechSynthesisUtterance(announcementText);
    if (chosenVoice) {
        utterance.voice = chosenVoice;
    }
    
    utterance.rate = 0.95;
    utterance.pitch = 1.05;
    
    synth.speak(utterance);
}

// -------------------------------------------------------------
// OPERATOR COMMANDS
// -------------------------------------------------------------
function opCallNext() {
    const nextItem = state.queue.find(item => item.status === 'waiting');
    if (!nextItem) {
        alert("ບໍ່ມີຄິວລໍຖ້າໃນຂະນະນີ້ (No pending queues available)");
        return;
    }
    
    // Mark old calling items as completed
    state.queue.forEach(item => {
        if (item.status === 'calling') {
            item.status = 'completed';
            item.completedAt = new Date().toLocaleTimeString('lo-LA', { hour: '2-digit', minute: '2-digit' });
        }
    });
    
    nextItem.status = 'calling';
    saveStateToStorage();
    
    // Trigger visual alert animation on TV Screen
    triggerTVAlert();
    
    // Play sound and speak
    playNotificationChime(() => {
        speakTicket(nextItem.number);
    });
}

function opRecall() {
    const activeItem = state.queue.find(item => item.status === 'calling');
    if (activeItem) {
        triggerTVAlert();
        playNotificationChime(() => {
            speakTicket(activeItem.number);
        });
    }
}

function opComplete() {
    const activeItem = state.queue.find(item => item.status === 'calling');
    if (activeItem) {
        activeItem.status = 'completed';
        activeItem.completedAt = new Date().toLocaleTimeString('lo-LA', { hour: '2-digit', minute: '2-digit' });
        saveStateToStorage();
    }
}

function opSkip(id) {
    const item = state.queue.find(i => i.id === id);
    if (item) {
        item.status = 'skipped';
        saveStateToStorage();
    }
}

function confirmResetQueue() {
    if (confirm("ທ່ານແນ່ໃຈບໍ່ວ່າຕ້ອງການລ້າງຂໍ້ມູນຄິວທັງໝົດ? ຂໍ້ມູນຄິວໃນມື້ນີ້ຈະຖືກລຶບອອກຖາວອນ.")) {
        resetState();
    }
}

function triggerTVAlert() {
    const tvServing = document.querySelector('.tv-serving-panel');
    if (tvServing) {
        tvServing.classList.remove('calling-alert');
        void tvServing.offsetWidth; 
        tvServing.classList.add('calling-alert');
        
        setTimeout(() => {
            tvServing.classList.remove('calling-alert');
        }, 3000);
    }
}

// -------------------------------------------------------------
// RENDER VIEWS LOGIC
// -------------------------------------------------------------
function renderAll() {
    const waitingList = state.queue.filter(item => item.status === 'waiting');
    const callingItem = state.queue.find(item => item.status === 'calling');
    const completedList = state.queue.filter(item => item.status === 'completed' || item.status === 'skipped');
    
    const waitTime = waitingList.length * state.avgWaitTimePerPerson;
    
    // --- 1. TV View Rendering ---
    const tvNumberBox = document.getElementById('tv-active-number');
    
    if (callingItem) {
        tvNumberBox.innerHTML = `<span>${callingItem.number}</span>`;
    } else {
        tvNumberBox.innerHTML = `<span>- - -</span>`;
    }
    
    // TV Upcoming list
    const tvUpcomingContainer = document.getElementById('tv-upcoming-list');
    const tvWaitingCount = document.getElementById('tv-waiting-count');
    
    tvWaitingCount.textContent = `${waitingList.length} ຄິວ`;
    
    if (waitingList.length === 0) {
        tvUpcomingContainer.innerHTML = `
            <div class="list-empty">
                <i data-lucide="inbox"></i>
                <p>ບໍ່ມີຄິວລໍຖ້າໃນຂະນະນີ້</p>
            </div>`;
    } else {
        tvUpcomingContainer.innerHTML = waitingList.map((item, idx) => `
            <div class="upcoming-item">
                <div class="item-left">
                    <div class="item-num">${item.number}</div>
                </div>
                <div class="item-right">
                    <span>${idx * state.avgWaitTimePerPerson} ນາທີ</span>
                </div>
            </div>
        `).join('');
    }
    
    // General Stats on TV View
    const totalTodayVal = isCloudSyncActive ? (state.ticketCounter - 1) : state.queue.length;
    const completedCountVal = isCloudSyncActive ? Math.max(0, state.ticketCounter - 1 - waitingList.length - (callingItem ? 1 : 0)) : state.queue.filter(i => i.status === 'completed').length;
    
    document.getElementById('stat-total-today').textContent = totalTodayVal;
    document.getElementById('stat-waiting-now').textContent = waitingList.length;
    document.getElementById('stat-avg-wait').textContent = `${waitTime} ນາທີ`;
    document.getElementById('stat-completed-count').textContent = completedCountVal;
    
    // --- 2. Operator View Rendering ---
    document.getElementById('op-wait-total').textContent = `${waitingList.length} ຄິວ`;
    document.getElementById('op-current-ticket').textContent = callingItem ? callingItem.number : '- - -';
    
    const opCompletedCountVal = isCloudSyncActive ? Math.max(0, state.ticketCounter - 1 - waitingList.length - (callingItem ? 1 : 0)) : state.queue.filter(i => i.status === 'completed').length;
    document.getElementById('op-completed-total').textContent = `${opCompletedCountVal} ຄິວ`;
    
    // Active Called Ticket info in Operator panel
    const opActiveNum = document.getElementById('op-active-call-num');
    const btnRecall = document.getElementById('btn-recall');
    const btnComplete = document.getElementById('btn-complete');
    
    if (callingItem) {
        opActiveNum.textContent = callingItem.number;
        btnRecall.removeAttribute('disabled');
        btnComplete.removeAttribute('disabled');
    } else {
        opActiveNum.textContent = '- - -';
        btnRecall.setAttribute('disabled', 'true');
        btnComplete.setAttribute('disabled', 'true');
    }
    
    // Operator Tables
    document.getElementById('count-tab-waiting').textContent = waitingList.length;
    document.getElementById('count-tab-completed').textContent = completedList.length;
    
    const waitingTableBody = document.getElementById('table-waiting-body');
    if (waitingList.length === 0) {
        waitingTableBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 2rem;">ບໍ່ມີຄິວລໍຖ້າ</td></tr>`;
    } else {
        waitingTableBody.innerHTML = waitingList.map(item => `
            <tr>
                <td style="font-family: var(--font-outfit); font-weight: 700; font-size: 1.1rem; color: var(--text-main); vertical-align: middle;">${item.number}</td>
                <td style="color: var(--text-muted); vertical-align: middle;">${item.timestamp}</td>
                <td style="vertical-align: middle;">
                    <button class="op-table-btn skip" onclick="opSkip('${item.id}')" title="ຂ້າມຄິວ (Skip)">
                        <i data-lucide="user-x"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }
    
    const completedTableBody = document.getElementById('table-completed-body');
    if (completedList.length === 0) {
        completedTableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">ບໍ່ມີປະຫວັດຄິວ</td></tr>`;
    } else {
        const sortedCompleted = [...completedList].sort((a, b) => b.rawTime - a.rawTime);
        completedTableBody.innerHTML = sortedCompleted.map(item => `
            <tr>
                <td style="font-family: var(--font-outfit); font-weight: 700; color: var(--text-muted); vertical-align: middle;">${item.number}</td>
                <td style="vertical-align: middle;">${item.timestamp}</td>
                <td style="vertical-align: middle;">${item.completedAt || '-'}</td>
                <td style="vertical-align: middle;">
                    <span style="color: ${item.status === 'completed' ? 'var(--neon-green)' : 'var(--neon-amber)'}; font-weight: 600;">
                        ${item.status === 'completed' ? 'ສຳເລັດແລ້ວ' : 'ຂ້າມຄິວ'}
                    </span>
                </td>
            </tr>
        `).join('');
    }
    
    lucide.createIcons();
}

// Switch between Tabs in Operator Panel
function switchOpTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    
    if (tab === 'waiting') {
        document.getElementById('table-waiting-view').classList.remove('hidden');
        document.getElementById('table-completed-view').classList.add('hidden');
    } else {
        document.getElementById('table-waiting-view').classList.add('hidden');
        document.getElementById('table-completed-view').classList.remove('hidden');
    }
}

// -------------------------------------------------------------
// CLOUD SYNC HELPERS (Custom Modal & Group Selector)
// -------------------------------------------------------------
function openCloudModal() {
    const modal = document.getElementById('cloud-sync-modal');
    if (modal) {
        modal.classList.remove('hidden');
        updateModalState();
    }
}

function closeCloudModal() {
    const modal = document.getElementById('cloud-sync-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

function selectQuickGroup(groupNumber) {
    const targetId = 'group' + groupNumber;
    connectToCloudRoomById(targetId);
}

function connectCustomGroup() {
    const val = document.getElementById('custom-group-input').value.trim();
    if (!val) {
        alert("ກະລຸນາປ້ອນ Room ID ທີ່ຕ້ອງການເຊື່ອມຕໍ່");
        return;
    }
    connectToCloudRoomById(val);
}

function connectToCloudRoomById(targetRoomId) {
    if (!targetRoomId) return;
    
    // Show user a quick visual loading
    const activeIdText = document.getElementById('modal-active-room-id');
    if (activeIdText) activeIdText.textContent = "ກຳລັງເຊື່ອມຕໍ່...";
    
    // Fetch state from keyvalue.immanuel.co
    fetch(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/yzqkpawz/${targetRoomId}?t=${Date.now()}`)
        .then(res => {
            if (!res.ok) throw new Error("Invalid ID");
            return res.json();
        })
        .then(val => {
            if (!val) {
                // Room is empty or new. Initialize it with current local state!
                cloudRoomId = targetRoomId;
                isCloudSyncActive = true;
                localStorage.setItem('snap_glow_cloud_room_id', targetRoomId);
                localStorage.setItem('snap_glow_cloud_sync_active', true);
                
                updateCloudUI();
                saveStateToStorage(); // Pushes active state to the newly created room ID
                renderAll();
                updateModalState();
                syncDevicePresence();
                alert(`ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍສຳເລັດແລ້ວ! (ສ້າງຫ້ອງໃໝ່ "${targetRoomId}" ດ້ວຍຂໍ້ມູນປັດຈຸບັນ)`);
                return;
            }
            let data;
            let isValid = false;
            try {
                const decoded = safeDecode(val);
                const parsed = JSON.parse(decoded);
                if (parsed && (parsed.q || parsed.queue)) {
                    data = parsed.q ? decompressState(parsed) : parsed;
                    if (validateState(data)) isValid = true;
                }
            } catch (e) {}
            
            if (!isValid) {
                try {
                    data = JSON.parse(hexToString(val));
                    if (validateState(data)) isValid = true;
                } catch (e) {
                    try {
                        data = JSON.parse(decodeURIComponent(val));
                        if (validateState(data)) isValid = true;
                    } catch (e2) {
                        try {
                            data = JSON.parse(val);
                            if (validateState(data)) isValid = true;
                        } catch (e3) {}
                    }
                }
            }
            
            if (isValid) {
                cloudRoomId = targetRoomId;
                isCloudSyncActive = true;
                localStorage.setItem('snap_glow_cloud_room_id', targetRoomId);
                localStorage.setItem('snap_glow_cloud_sync_active', true);
                
                const serverWaitingAndCalling = data.queue.filter(item => item.status === 'waiting' || item.status === 'calling');
                const localCompletedOrSkipped = state.queue.filter(item => item.status === 'completed' || item.status === 'skipped');
                const mergedQueue = [...serverWaitingAndCalling, ...localCompletedOrSkipped];
                state = {
                    queue: mergedQueue,
                    ticketCounter: Math.max(state.ticketCounter, data.ticketCounter),
                    avgWaitTimePerPerson: data.avgWaitTimePerPerson || 5
                };
                localStorage.setItem('snap_glow_queue_state', JSON.stringify(state));
                
                updateCloudUI();
                renderAll();
                updateModalState();
                syncDevicePresence(); // Refresh presence instantly
                alert(`ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍ "${targetRoomId}" ສຳເລັດແລ້ວ!`);
            } else {
                // Auto-initialize if data in room is invalid
                cloudRoomId = targetRoomId;
                isCloudSyncActive = true;
                localStorage.setItem('snap_glow_cloud_room_id', targetRoomId);
                localStorage.setItem('snap_glow_cloud_sync_active', true);
                
                updateCloudUI();
                saveStateToStorage(); // Overwrites invalid data in the cloud with current local state
                renderAll();
                updateModalState();
                syncDevicePresence(); // Refresh presence instantly
                alert(`ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍ "${targetRoomId}" ສຳເລັດແລ້ວ! (ລີເຊັດຂໍ້ມູນຫ້ອງໃໝ່)`);
            }
        })
        .catch(err => {
            // Fallback for network error / key not found. Initialize new room.
            cloudRoomId = targetRoomId;
            isCloudSyncActive = true;
            localStorage.setItem('snap_glow_cloud_room_id', targetRoomId);
            localStorage.setItem('snap_glow_cloud_sync_active', true);
            
            updateCloudUI();
            saveStateToStorage();
            renderAll();
            updateModalState();
            alert(`ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍສຳເລັດແລ້ວ! (ສ້າງຫ້ອງໃໝ່ "${targetRoomId}" ດ້ວຍຂໍ້ມູນປັດຈຸບັນ)`);
        });
}

function disconnectCloudSync() {
    isCloudSyncActive = false;
    localStorage.setItem('snap_glow_cloud_sync_active', false);
    updateCloudUI();
    renderAll();
    updateModalState();
    alert("ຍົກເລີກການເຊື່ອມຕໍ່ອອນລາຍແລ້ວ. ລະບົບຈະກັບມາໃຊ້ Local Network.");
}

function updateCloudUI() {
    const indicator = document.getElementById('header-cloud-indicator');
    const badge = document.getElementById('op-cloud-badge');
    
    if (isCloudSyncActive && cloudRoomId) {
        if (indicator) {
            indicator.className = "header-cloud-sync online";
            const displayId = cloudRoomId.length > 15 ? cloudRoomId.slice(0, 12) + "..." : cloudRoomId;
            indicator.innerHTML = `<i data-lucide="cloud"></i> <span>Online: ${displayId}</span>`;
        }
        if (badge) {
            badge.textContent = `Online: ${cloudRoomId}`;
            badge.style.background = "rgba(16, 185, 129, 0.15)";
            badge.style.color = "#10b981";
        }
    } else {
        if (indicator) {
            indicator.className = "header-cloud-sync offline";
            indicator.innerHTML = `<i data-lucide="cloud-off"></i> <span>Offline</span>`;
        }
        if (badge) {
            badge.textContent = "Offline";
            badge.style.background = "rgba(239, 68, 68, 0.15)";
            badge.style.color = "#ef4444";
        }
    }
    lucide.createIcons();
}

function updateModalState() {
    // Reset group buttons
    document.querySelectorAll('.btn-group-select').forEach(btn => btn.classList.remove('active'));
    
    const activeArea = document.getElementById('modal-active-room-area');
    const activeId = document.getElementById('modal-active-room-id');
    const customInput = document.getElementById('custom-group-input');
    
    if (isCloudSyncActive && cloudRoomId) {
        if (activeArea) activeArea.classList.remove('hidden');
        if (activeId) activeId.textContent = cloudRoomId;
        
        // Highlight corresponding group button if group1/2/3
        if (cloudRoomId === 'group1') {
            const btn = document.getElementById('btn-group-1');
            if (btn) btn.classList.add('active');
        } else if (cloudRoomId === 'group2') {
            const btn = document.getElementById('btn-group-2');
            if (btn) btn.classList.add('active');
        } else if (cloudRoomId === 'group3') {
            const btn = document.getElementById('btn-group-3');
            if (btn) btn.classList.add('active');
        } else {
            if (customInput) customInput.value = cloudRoomId;
        }
    } else {
        if (activeArea) activeArea.classList.add('hidden');
        if (customInput) customInput.value = '';
    }
}

// -------------------------------------------------------------
// DEVICE PRESENCE SYNCING
// -------------------------------------------------------------
function getActiveRole() {
    if (document.getElementById('view-kiosk').classList.contains('active-view')) return 'Kiosk';
    if (document.getElementById('view-tv').classList.contains('active-view')) return 'TV';
    if (document.getElementById('view-operator').classList.contains('active-view')) return 'Operator';
    return 'Client';
}

function syncDevicePresence() {
    if (!isCloudSyncActive || !cloudRoomId) {
        activeDevicesCount = 1;
        updatePresenceUI();
        return;
    }
    
    const presenceKey = `${cloudRoomId}_presence`;
    
    fetch(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/yzqkpawz/${presenceKey}?t=${Date.now()}`)
        .then(res => {
            if (!res.ok) return null;
            return res.json();
        })
        .then(val => {
            let presenceMap = {};
            if (val) {
                try {
                    const decoded = safeDecode(val);
                    const parsed = JSON.parse(decoded);
                    if (Array.isArray(parsed)) {
                        presenceMap = decompressPresence(parsed);
                    } else {
                        presenceMap = parsed;
                    }
                } catch (e) {
                    try {
                        presenceMap = JSON.parse(hexToString(val));
                    } catch(e2) {
                        try {
                            presenceMap = JSON.parse(decodeURIComponent(val));
                        } catch(e3) {
                            try {
                                presenceMap = JSON.parse(val);
                            } catch(e4) {}
                        }
                    }
                }
            }
            
            if (typeof presenceMap !== 'object' || presenceMap === null) {
                presenceMap = {};
            }
            
            const now = Date.now();
            presenceMap[myDeviceId] = {
                role: getActiveRole(),
                lastSeen: now
            };
            
            const activeMap = {};
            let count = 0;
            for (const devId in presenceMap) {
                if (now - presenceMap[devId].lastSeen < 8000) {
                    activeMap[devId] = presenceMap[devId];
                    count++;
                }
            }
            
            activeDevicesCount = count;
            updatePresenceUI(activeMap);
            
            const compressed = compressPresence(activeMap);
            const valToSend = safeEncode(JSON.stringify(compressed));
            fetch(`https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/yzqkpawz/${presenceKey}/${valToSend}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=1'
            }).catch(() => {});
        })
        .catch(() => {});
}

function updatePresenceUI(activeMap) {
    const indicator = document.getElementById('header-cloud-indicator');
    const badge = document.getElementById('op-cloud-badge');
    
    if (indicator && isCloudSyncActive && cloudRoomId) {
        const displayId = cloudRoomId.length > 15 ? cloudRoomId.slice(0, 12) + "..." : cloudRoomId;
        indicator.innerHTML = `<i data-lucide="cloud"></i> <span>Online: ${displayId} (${activeDevicesCount} ອຸປະກອນ)</span>`;
    }
    
    if (badge && isCloudSyncActive && cloudRoomId) {
        badge.textContent = `Online: ${cloudRoomId} (${activeDevicesCount})`;
    }
    
    const countSpan = document.getElementById('presence-count');
    if (countSpan) countSpan.textContent = activeDevicesCount;
    
    const container = document.getElementById('presence-devices-container');
    if (!container) return;
    
    if (!activeMap || Object.keys(activeMap).length === 0) {
        container.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); text-align: center; padding: 4px;">ກຳລັງໂຫຼດຂໍ້ມູນອຸປະກອນ...</div>`;
        return;
    }
    
    let html = '';
    for (const devId in activeMap) {
        const dev = activeMap[devId];
        const isMe = devId === myDeviceId;
        let iconName = 'monitor';
        let roleName = dev.role;
        
        if (dev.role === 'Operator') iconName = 'sliders';
        else if (dev.role === 'TV') iconName = 'tv';
        else if (dev.role === 'Kiosk') iconName = 'monitor-play';
        
        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; padding: 6px 10px; background: rgba(255,255,255,0.4); border-radius: 8px; border: 1px solid rgba(197, 160, 89, 0.08);">
                <span style="font-weight: 500; display: flex; align-items: center; gap: 6px; color: var(--text-main);">
                    <i data-lucide="${iconName}" style="width: 14px; height: 14px; color: var(--neon-gold-dark);"></i> 
                    ${roleName} ${isMe ? '(ອຸປະກອນນີ້)' : ''}
                </span>
                <span style="font-size: 0.75rem; color: var(--neon-green); font-weight: 700; display: flex; align-items: center; gap: 4px;">
                    <span style="width: 6px; height: 6px; background: var(--neon-green); border-radius: 50%; display: inline-block;"></span> Active
                </span>
            </div>
        `;
    }
    
    container.innerHTML = html;
    lucide.createIcons();
}

// Custom URL-safe encoding/decoding to prevent IIS path validation and segment length issues
function safeEncode(str) {
    if (!str) return '';
    return str
        .replace(/_/g, '_U')
        .replace(/:/g, '_C')
        .replace(/,/g, '_K')
        .replace(/\{/g, '_L')
        .replace(/\}/g, '_R')
        .replace(/\[/g, '_A')
        .replace(/\]/g, '_B')
        .replace(/"/g, '_Q')
        .replace(/\//g, '_S')
        .replace(/\+/g, '_P')
        .replace(/=/g, '_E');
}

function safeDecode(str) {
    if (!str) return '';
    return str
        .replace(/_E/g, '=')
        .replace(/_P/g, '+')
        .replace(/_S/g, '/')
        .replace(/_Q/g, '"')
        .replace(/_B/g, ']')
        .replace(/_A/g, '[')
        .replace(/_R/g, '}')
        .replace(/_L/g, '{')
        .replace(/_K/g, ',')
        .replace(/_C/g, ':')
        .replace(/_U/g, '_');
}

// Highly compact representation for cloud synchronization (keeps segment size < 260 characters)
function compressState(fullState) {
    const compressed = {
<<<<<<< HEAD
        q: [],  // flat array of waiting: [num1, time1, num2, time2, ...]
        c: 0,   // calling ticket number (0 if none)
        ct: 0,  // calling ticket check-in time (minutes since midnight)
=======
        q: [],
>>>>>>> 9859f54265d3fe02db5c16fa074924e4c93c1c37
        tc: fullState.ticketCounter || 1,
        wt: fullState.avgWaitTimePerPerson || 5
    };
    
    if (fullState.queue && Array.isArray(fullState.queue)) {
<<<<<<< HEAD
        const waitingTickets = fullState.queue.filter(item => item.status === 'waiting');
        const callingTicket = fullState.queue.find(item => item.status === 'calling');
        
        if (callingTicket) {
            const numMatch = callingTicket.number ? callingTicket.number.match(/\d+/) : null;
            compressed.c = numMatch ? parseInt(numMatch[0], 10) : 0;
            compressed.ct = timeToMinutes(callingTicket.timestamp);
        }
        
        waitingTickets.forEach(item => {
            const numMatch = item.number ? item.number.match(/\d+/) : null;
            const numVal = numMatch ? parseInt(numMatch[0], 10) : 0;
            const timeVal = timeToMinutes(item.timestamp);
            compressed.q.push(numVal, timeVal);
=======
        // Keep waiting and calling, plus only last 3 completed/skipped to save space
        const waitingAndCalling = fullState.queue.filter(item => item.status === 'waiting' || item.status === 'calling');
        const completedOrSkipped = fullState.queue.filter(item => item.status === 'completed' || item.status === 'skipped');
        
        completedOrSkipped.sort((a, b) => (b.rawTime || 0) - (a.rawTime || 0));
        const trimmedCompletedOrSkipped = completedOrSkipped.slice(0, 3);
        const trimmedQueue = [...waitingAndCalling, ...trimmedCompletedOrSkipped];
        
        compressed.q = trimmedQueue.map(item => {
            const numMatch = item.number ? item.number.match(/\d+/) : null;
            const numVal = numMatch ? parseInt(numMatch[0], 10) : 0;
            
            let statusCode = 'w';
            if (item.status === 'calling') statusCode = 'c';
            else if (item.status === 'completed') statusCode = 'd';
            else if (item.status === 'skipped') statusCode = 's';
            
            return [
                numVal,
                item.timestamp || '',
                statusCode,
                item.completedAt || '',
                item.rawTime || Date.now()
            ];
>>>>>>> 9859f54265d3fe02db5c16fa074924e4c93c1c37
        });
    }
    return compressed;
}

function decompressState(comp) {
    if (!comp) return null;
<<<<<<< HEAD
    
=======
>>>>>>> 9859f54265d3fe02db5c16fa074924e4c93c1c37
    const full = {
        queue: [],
        ticketCounter: comp.tc || 1,
        avgWaitTimePerPerson: comp.wt || 5
    };
    
<<<<<<< HEAD
    function minutesToTime(mins) {
        if (!mins) {
            const now = new Date();
            return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        }
        const h = Math.floor(mins / 60) % 24;
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    
    if (comp.c) {
        const formattedNumber = `Q-${String(comp.c).padStart(3, '0')}`;
        full.queue.push({
            id: 'q_call_' + comp.c,
            number: formattedNumber,
            status: 'calling',
            timestamp: minutesToTime(comp.ct),
            completedAt: '',
            rawTime: Date.now()
        });
    }
    
    if (comp.q && Array.isArray(comp.q)) {
        for (let i = 0; i < comp.q.length; i += 2) {
            const numVal = comp.q[i];
            const timeVal = comp.q[i+1];
            if (numVal === undefined) break;
            
            const formattedNumber = `Q-${String(numVal).padStart(3, '0')}`;
            full.queue.push({
                id: 'q_' + numVal,
                number: formattedNumber,
                status: 'waiting',
                timestamp: minutesToTime(timeVal),
                completedAt: '',
                rawTime: Date.now() + i
            });
        }
    }
    
    return full;
}

function timeToMinutes(timestampStr) {
    if (!timestampStr) {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
    }
    const parts = timestampStr.split(':');
    if (parts.length >= 2) {
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

=======
    if (comp.q && Array.isArray(comp.q)) {
        full.queue = comp.q.map(arr => {
            const numVal = arr[0];
            const prefix = 'Q';
            const formattedNumber = `${prefix}-${String(numVal).padStart(3, '0')}`;
            
            let status = 'waiting';
            if (arr[2] === 'c') status = 'calling';
            else if (arr[2] === 'd') status = 'completed';
            else if (arr[2] === 's') status = 'skipped';
            
            return {
                id: 'q_' + (arr[4] || Date.now() + Math.random()),
                number: formattedNumber,
                status: status,
                timestamp: arr[1] || '',
                completedAt: arr[3] || '',
                rawTime: arr[4] || Date.now()
            };
        });
    }
    return full;
}

>>>>>>> 9859f54265d3fe02db5c16fa074924e4c93c1c37
function compressPresence(presenceMap) {
    const arr = [];
    const now = Date.now();
    for (const devId in presenceMap) {
        if (now - presenceMap[devId].lastSeen < 15000) {
            let roleCode = 'C';
            if (presenceMap[devId].role === 'Operator') roleCode = 'O';
            else if (presenceMap[devId].role === 'TV') roleCode = 'T';
            else if (presenceMap[devId].role === 'Kiosk') roleCode = 'K';
            
            const cleanId = devId.replace('dev_', '');
            arr.push([
                cleanId,
                roleCode,
                Math.floor(presenceMap[devId].lastSeen / 1000)
            ]);
        }
    }
    return arr;
}

function decompressPresence(arr) {
    const presenceMap = {};
    if (!arr || !Array.isArray(arr)) return presenceMap;
    
    arr.forEach(item => {
        const cleanId = item[0];
        const roleCode = item[1];
        const lastSeenSec = item[2];
        
        let role = 'Client';
        if (roleCode === 'O') role = 'Operator';
        else if (roleCode === 'T') role = 'TV';
        else if (roleCode === 'K') role = 'Kiosk';
        
        presenceMap['dev_' + cleanId] = {
            role: role,
            lastSeen: lastSeenSec * 1000
        };
    });
    return presenceMap;
}

// Hex Encoding/Decoding Helpers to prevent IIS path validation errors
function stringToHex(str) {
    let hex = '';
    for (let i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex;
}

function hexToString(hex) {
    if (!hex) return '';
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str;
}

