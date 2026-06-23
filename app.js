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
let cloudRoomId = localStorage.getItem('snap_glow_cloud_room_id') || '';
let isCloudSyncActive = localStorage.getItem('snap_glow_cloud_sync_active') === 'true';

// Initialize application
document.addEventListener("DOMContentLoaded", () => {
    // Initialize icons
    lucide.createIcons();
    
    // Load state from server initially, fallback to local storage
    loadStateFromServer();
    
    // Poll server every 1.2s for real-time queue updates across other devices
    setInterval(loadStateFromServer, 1200);

    
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
    const syncToggle = document.getElementById('online-sync-toggle');
    if (syncToggle) {
        syncToggle.checked = isCloudSyncActive;
        syncToggle.addEventListener('change', (e) => {
            toggleOnlineSync(e.target.checked);
        });
    }

    // Default step initialization
    goToStep('welcome');

    // Initial render
    renderAll();
});

// Load/Save State
function validateState(data) {
    return data && Array.isArray(data.queue) && typeof data.ticketCounter === 'number';
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
        // Fetch from public ExtendsClass cloud
        fetch(`https://extendsclass.com/api/json-storage/bin/${cloudRoomId}?t=${Date.now()}`)
            .then(res => {
                if (!res.ok) throw new Error("Cloud fetch failed");
                return res.json();
            })
            .then(data => {
                if (!isUpdatingNetwork) {
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
    } else {
        // Fetch from local python server
        fetch('/api/state')
            .then(res => {
                if (!res.ok) throw new Error("Server error");
                return res.json();
            })
            .then(data => {
                if (!isUpdatingNetwork) {
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
        // Write to public ExtendsClass cloud
        fetch(`https://extendsclass.com/api/json-storage/bin/${cloudRoomId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(state)
        })
        .then(res => {
            if (!res.ok) throw new Error("Cloud write failed");
            return res.json();
        })
        .then(data => {
            isUpdatingNetwork = false;
        })
        .catch(err => {
            console.error("Failed to sync queue state to cloud:", err);
            isUpdatingNetwork = false;
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
        })
        .catch(err => {
            console.error("Failed to sync queue state to server:", err);
            isUpdatingNetwork = false;
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
    document.getElementById('stat-total-today').textContent = state.queue.length;
    document.getElementById('stat-waiting-now').textContent = waitingList.length;
    document.getElementById('stat-avg-wait').textContent = `${waitTime} ນາທີ`;
    document.getElementById('stat-completed-count').textContent = state.queue.filter(i => i.status === 'completed').length;
    
    // --- 2. Operator View Rendering ---
    document.getElementById('op-wait-total').textContent = `${waitingList.length} ຄິວ`;
    document.getElementById('op-current-ticket').textContent = callingItem ? callingItem.number : '- - -';
    document.getElementById('op-completed-total').textContent = `${state.queue.filter(i => i.status === 'completed').length} ຄິວ`;
    
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
// CLOUD SYNC HELPERS
// -------------------------------------------------------------
function toggleOnlineSync(isActive) {
    isCloudSyncActive = isActive;
    localStorage.setItem('snap_glow_cloud_sync_active', isActive);
    
    if (isActive) {
        if (!cloudRoomId) {
            // Create a new public ExtendsClass room
            fetch('https://extendsclass.com/api/json-storage/bin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify(state)
            })
            .then(res => {
                if (!res.ok) throw new Error("Failed to create room");
                return res.json();
            })
            .then(data => {
                if (data && data.id) {
                    return data.id;
                }
                throw new Error("Invalid response from storage server");
            })
            .then(id => {
                cloudRoomId = id;
                localStorage.setItem('snap_glow_cloud_room_id', id);
                updateCloudUI();
                saveStateToStorage(); // Push active state
            })
            .catch(err => {
                console.error("Failed to initialize cloud room:", err);
                alert("ບໍ່ສາມາດສ້າງຫ້ອງອອນລາຍໄດ້ໃນຂະນະນີ້. ກະລຸນາກວດສອບອິນເຕີເນັດ.");
                isCloudSyncActive = false;
                localStorage.setItem('snap_glow_cloud_sync_active', false);
                const syncToggle = document.getElementById('online-sync-toggle');
                if (syncToggle) syncToggle.checked = false;
                updateCloudUI();
            });
        } else {
            updateCloudUI();
            saveStateToStorage();
        }
    } else {
        updateCloudUI();
    }
}

function updateCloudUI() {
    const onlineRow = document.getElementById('online-room-row');
    const roomInput = document.getElementById('online-room-id');
    const indicator = document.getElementById('header-cloud-indicator');
    
    if (isCloudSyncActive && cloudRoomId) {
        if (onlineRow) onlineRow.classList.remove('hidden');
        if (roomInput) roomInput.value = cloudRoomId;
        if (indicator) {
            indicator.className = "header-cloud-sync online";
            // Show short Room ID in header
            const shortId = cloudRoomId.slice(0, 8);
            indicator.innerHTML = `<i data-lucide="cloud"></i> <span>Online: ${shortId}</span>`;
        }
    } else {
        if (onlineRow) onlineRow.classList.add('hidden');
        if (indicator) {
            indicator.className = "header-cloud-sync offline";
            indicator.innerHTML = `<i data-lucide="cloud-off"></i> <span>Offline</span>`;
        }
    }
    lucide.createIcons();
}

function copyRoomID() {
    if (cloudRoomId) {
        navigator.clipboard.writeText(cloudRoomId)
            .then(() => alert("ຄັດລອກ Cloud Room ID ສຳເລັດແລ້ວ!"))
            .catch(err => console.error("Clipboard write error:", err));
    }
}

function connectToCloudRoom() {
    const inputVal = document.getElementById('connect-room-id').value.trim();
    if (!inputVal) {
        alert("ກະລຸນາປ້ອນ Room ID ທີ່ຕ້ອງການເຊື່ອມຕໍ່");
        return;
    }
    
    if (confirm("ຕ້ອງການເຊື່ອມຕໍ່ຫ້ອງນີ້? ຂໍ້ມູນຄິວປັດຈຸບັນໃນເຄື່ອງນີ້ຈະຖືກແທນທີ່ດ້ວຍຂໍ້ມູນອອນລາຍ.")) {
        // Fetch new room state to verify it works
        fetch(`https://extendsclass.com/api/json-storage/bin/${inputVal}?t=${Date.now()}`)
            .then(res => {
                if (!res.ok) throw new Error("Invalid room ID");
                return res.json();
            })
            .then(data => {
                if (validateState(data)) {
                    cloudRoomId = inputVal;
                    isCloudSyncActive = true;
                    localStorage.setItem('snap_glow_cloud_room_id', inputVal);
                    localStorage.setItem('snap_glow_cloud_sync_active', true);
                    
                    // Clear input
                    document.getElementById('connect-room-id').value = '';
                    
                    // Set toggle checked
                    const syncToggle = document.getElementById('online-sync-toggle');
                    if (syncToggle) syncToggle.checked = true;
                    
                    state = data;
                    localStorage.setItem('snap_glow_queue_state', JSON.stringify(state));
                    updateCloudUI();
                    renderAll();
                    alert("ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍສຳເລັດແລ້ວ!");
                } else {
                    alert("ເຊື່ອມຕໍ່ບໍ່ສຳເລັດ: ຂໍ້ມູນໃນຫ້ອງນີ້ບໍ່ຖືກຕ້ອງ.");
                }
            })
            .catch(err => {
                alert("ເຊື່ອມຕໍ່ບໍ່ສຳເລັດ: ບໍ່ພົບ Room ID ດັ່ງກ່າວ ຫຼື ໝົດອາຍຸແລ້ວ.");
            });
    }
}

function promptCloudRoom() {
    const currentStatus = isCloudSyncActive ? `ເຊື່ອມຕໍ່ຢູ່ໃນຫ້ອງ ID: ${cloudRoomId}\n\n` : '';
    const inputVal = prompt(`${currentStatus}ປ້ອນ Cloud Room ID ເພື່ອຊິ້ງຂໍ້ມູນອອນລາຍ (ປ້ອນຄ່າວ່າງເພື່ອຍົກເລີກອອນລາຍ):`);
    
    if (inputVal === null) return; // cancel click
    
    if (inputVal.trim() === '') {
        // Turn off cloud sync
        isCloudSyncActive = false;
        localStorage.setItem('snap_glow_cloud_sync_active', false);
        const syncToggle = document.getElementById('online-sync-toggle');
        if (syncToggle) syncToggle.checked = false;
        updateCloudUI();
        renderAll();
        alert("ຍົກເລີກການຊິ້ງອອນລາຍແລ້ວ. ລະບົບຈະກັບມາໃຊ້ Local Network.");
        return;
    }
    
    const targetRoomId = inputVal.trim();
    fetch(`https://extendsclass.com/api/json-storage/bin/${targetRoomId}?t=${Date.now()}`)
        .then(res => {
            if (!res.ok) throw new Error("Invalid ID");
            return res.json();
        })
        .then(data => {
            if (validateState(data)) {
                cloudRoomId = targetRoomId;
                isCloudSyncActive = true;
                localStorage.setItem('snap_glow_cloud_room_id', targetRoomId);
                localStorage.setItem('snap_glow_cloud_sync_active', true);
                
                const syncToggle = document.getElementById('online-sync-toggle');
                if (syncToggle) syncToggle.checked = true;
                
                state = data;
                localStorage.setItem('snap_glow_queue_state', JSON.stringify(state));
                updateCloudUI();
                renderAll();
                alert("ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍສຳເລັດແລ້ວ!");
            } else {
                alert("ເຊື່ອມຕໍ່ບໍ່ສຳເລັດ: ຂໍ້ມູນໃນຫ້ອງນີ້ບໍ່ຖືກຕ້ອງ.");
            }
        })
        .catch(err => {
            alert("ເຊື່ອມຕໍ່ບໍ່ສຳເລັດ: ບໍ່ພົບ Room ID ດັ່ງກ່າວ ຫຼື ໝົດອາຍຸແລ້ວ.");
        });
}

