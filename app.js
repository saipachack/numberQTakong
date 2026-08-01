// ==========================================
// SNAP & GLOW Queue Management Script
// Powered by Firebase Firestore (Real-time)
// ==========================================

// ── Firebase Configuration ──────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyB6cvzGms7c0lnXFRptVT7M9ocxXrEnYLc",
    authDomain: "takong-photobooth.firebaseapp.com",
    projectId: "takong-photobooth",
    storageBucket: "takong-photobooth.firebasestorage.app",
    messagingSenderId: "366115705560",
    appId: "1:366115705560:web:16330112b4a9478e9cfdad"
};

const fbApp = firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ── Global state ─────────────────────────────────────────────
let state = {
    queue: [],
    ticketCounter: 1,
    avgWaitTimePerPerson: 5
};

// ── Package & Payment ─────────────────────────────────────────
let selectedPackage = null;    // 'none' | 'large' | 'small2' | 'combo' | 'large2'
let selectedPayment = null;    // 'cash' | 'transfer'

const PACKAGE_CONFIG = {
    none:   { label: '🎫 ບໍ່ພິມ',        price: 50000,  desc: 'Digital ເທົ່ານັ້ນ' },
    large:  { label: '🖼️ ຮູບໃຫຍ່ 1 ໃບ', price: 100000, desc: 'A4 / ໃຫຍ່' },
    small2: { label: '📸 ຮູບນ້ອຍ 2 ໃບ', price: 100000, desc: '4×6 ສອງໃບ' },
    combo:  { label: '🎁 ໃຫຍ່ 1 + ນ້ອຍ 2',          price: 150000, desc: 'Combo Set' },
    large2: { label: '🖼️🖼️ ຮູບໃຫຍ່ 2 ໃບ', price: 150000, desc: 'A4 ສອງໃບ' }
};

// ── Admin ─────────────────────────────────────────────────────
const ADMIN_PIN = '5525';
let adminPinEntry = '';
let activeEventId = localStorage.getItem('snap_glow_active_event_id') || null;
let activeEventName = localStorage.getItem('snap_glow_active_event_name') || 'ງານທົ່ວໄປ';

// ── Cloud / Firebase Sync ─────────────────────────────────────
const synth = window.speechSynthesis;
let availableVoices = [];
let isUpdatingNetwork = false;
let lastWriteTime = 0;
let cloudRoomId = localStorage.getItem('snap_glow_cloud_room_id') || '';
let isCloudSyncActive = localStorage.getItem('snap_glow_cloud_sync_active') === 'true';
let selectedModalRoleVal = 'kiosk';
let firestoreUnsubscribe = null;   // Firestore onSnapshot unsubscribe function
const MASTER_BIN_ID = 'adfbded';   // legacy - kept for backward compat display only

// Device Presence State
const myDeviceId = 'dev_' + Math.random().toString(36).substring(2, 9);
let activeDevicesCount = 1;

// Interval trackers for dynamic polling (presence only now, queue uses onSnapshot)
let presenceIntervalId = null;
let pollIntervalId = null;


// ── setupIntervals: presence only (queue uses Firestore onSnapshot) ──
function setupIntervals() {
    if (document.hidden) return;
    if (pollIntervalId) clearInterval(pollIntervalId);
    if (presenceIntervalId) clearInterval(presenceIntervalId);

    const role = getActiveRole();
    const presenceTime = (role === 'TV') ? 30000 : 45000;
    presenceIntervalId = setInterval(syncDevicePresence, presenceTime);
}

// ── Subscribe / Unsubscribe Firestore room ──────────────────
function subscribeToFirestoreRoom(roomId) {
    if (firestoreUnsubscribe) {
        firestoreUnsubscribe();
        firestoreUnsubscribe = null;
    }
    if (!roomId) return;

    const roomRef = db.collection('rooms').doc(roomId);
    firestoreUnsubscribe = roomRef.onSnapshot((snap) => {
        if (!snap.exists) return;
        const data = snap.data();
        
        // Sync active event info from cloud
        if (data.activeEventId !== undefined && data.activeEventId !== activeEventId) {
            activeEventId = data.activeEventId;
            if (activeEventId) {
                localStorage.setItem('snap_glow_active_event_id', activeEventId);
            } else {
                localStorage.removeItem('snap_glow_active_event_id');
            }
        }
        if (data.activeEventName !== undefined && data.activeEventName !== activeEventName) {
            activeEventName = data.activeEventName || 'ຍັງບໍ່ໄດ້ສ້າງງານ';
            localStorage.setItem('snap_glow_active_event_name', activeEventName);
            
            // Update admin UI if it's currently open
            const eventNameEl = document.getElementById('admin-active-event-name');
            const eventDateEl = document.getElementById('admin-active-event-date');
            if (eventNameEl) eventNameEl.textContent = activeEventName;
            if (eventDateEl) eventDateEl.textContent = "ID: " + (activeEventId || 'None');
        }

        if (!data || !data.queue) return;
        const parsed = {
            queue: data.queue,
            ticketCounter: data.ticketCounter || 1,
            avgWaitTimePerPerson: data.avgWaitTimePerPerson || 5
        };
        if (validateState(parsed)) {
            state = parsed;
            localStorage.setItem('snap_glow_queue_state', JSON.stringify(state));
            renderAll();
        }
    }, (err) => {
        console.warn('Firestore onSnapshot error:', err);
        loadStateFromStorage();
    });
}

// ── Page visibility ──────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (pollIntervalId) clearInterval(pollIntervalId);
        if (presenceIntervalId) clearInterval(presenceIntervalId);
        pollIntervalId = null;
        presenceIntervalId = null;
    } else {
        loadStateFromServer();
        syncDevicePresence();
        setupIntervals();
    }
});



// Initialize application
document.addEventListener("DOMContentLoaded", () => {
    // Initialize icons
    lucide.createIcons();

    // If cloud sync is active, subscribe to Firestore room
    if (isCloudSyncActive && cloudRoomId) {
        subscribeToFirestoreRoom(cloudRoomId);
    } else {
        loadStateFromServer();
    }

    // Start presence sync intervals
    setupIntervals();
    syncDevicePresence();

    // Ensure active event exists on Firestore
    ensureActiveEvent();

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

    // Restore persisted role or default to kiosk
    const savedRole = localStorage.getItem('snap_glow_device_role') || 'kiosk';
    switchRole(savedRole);

    // Initial render
    renderAll();
});



// Helper to clean duplicate tickets from a queue, keeping the one with higher status precedence
function cleanDuplicateTickets(queue) {
    if (!Array.isArray(queue)) return [];
    const uniqueMap = new Map();
    queue.forEach(item => {
        if (!item || !item.number) return;
        const existing = uniqueMap.get(item.number);
        if (!existing) {
            uniqueMap.set(item.number, item);
        } else {
            const statusPrecedence = { 'completed': 3, 'skipped': 3, 'calling': 2, 'waiting': 1 };
            const existingPrec = statusPrecedence[existing.status] || 0;
            const itemPrec = statusPrecedence[item.status] || 0;
            if (itemPrec > existingPrec) {
                uniqueMap.set(item.number, item);
            } else if (itemPrec === existingPrec) {
                if (item.completedAt && !existing.completedAt) {
                    uniqueMap.set(item.number, item);
                }
            }
        }
    });
    return Array.from(uniqueMap.values());
}

// Helper to get integer value from ticket number string (e.g. "Q-050" -> 50)
function getTicketNumberValue(ticketNumberStr) {
    if (!ticketNumberStr) return 0;
    const match = ticketNumberStr.match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
}

// Helper to merge server queue state and local queue state without duplicates
function mergeQueues(serverQueue, localQueue, serverTicketCounter) {
    const sQueue = serverQueue || [];
    const lQueue = localQueue || [];
    const tc = typeof serverTicketCounter === 'number' ? serverTicketCounter : 1;
    
    // Create a set of ticket numbers present in the server queue
    const serverNumbers = new Set(sQueue.filter(item => item && item.number).map(item => item.number));
    
    // Filter local queue to keep:
    // 1. Completed/skipped tickets
    // 2. Waiting/calling tickets that are already on the server
    // 3. Waiting/calling tickets not on the server but with number >= serverTicketCounter (unsynced new tickets)
    const filteredLocal = lQueue.filter(item => {
        if (!item || !item.number) return false;
        
        if (item.status === 'completed' || item.status === 'skipped') {
            return true;
        }
        
        if (serverNumbers.has(item.number)) {
            return true;
        }
        
        const numVal = getTicketNumberValue(item.number);
        if (numVal >= tc) {
            return true;
        }
        
        return false;
    });
    
    const combined = [...sQueue, ...filteredLocal];
    const cleaned = cleanDuplicateTickets(combined);
    
    // Split and trim completed/skipped tickets to most recent 5
    const waitingAndCalling = cleaned.filter(item => item && (item.status === 'waiting' || item.status === 'calling'));
    const completedOrSkipped = cleaned.filter(item => item && (item.status === 'completed' || item.status === 'skipped'));
    
    completedOrSkipped.sort((a, b) => {
        const aTime = a.rawTime || 0;
        const bTime = b.rawTime || 0;
        return bTime - aTime;
    });
    
    const trimmedCompletedOrSkipped = completedOrSkipped.slice(0, 10);
    
    return [...waitingAndCalling, ...trimmedCompletedOrSkipped];
}

// Load/Save State
function validateState(data) {
    if (data && Array.isArray(data.queue)) {
        data.queue = cleanDuplicateTickets(data.queue);
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
        if (!cloudBinId) return Promise.resolve(); // Skip polling if bin ID is not resolved yet
        
        const fetchStartTime = Date.now();
        // Fetch from extendsclass.com JSON Storage
        return fetch(`https://extendsclass.com/api/json-storage/bin/${cloudBinId}?t=${Date.now()}`)
            .then(res => {
                if (!res.ok) throw new Error("Cloud fetch failed");
                return res.json();
            })
            .then(resObj => {
                if (!resObj) return;
                
                // ExtendsClass returns the JSON object. We stored our value in the 'value' field.
                const val = (resObj && typeof resObj === 'object' && resObj.value !== undefined) ? resObj.value : resObj;
                
                let data;
                try {
                    if (typeof val === 'string' && /^[0-9a-z]{7,}$/.test(val)) {
                        data = decompressCompactState(val);
                    } else if (typeof val === 'string' && /^\d+(,\d+)*$/.test(val)) {
                        const arr = val.split(',').map(Number);
                        data = decompressState(arr);
                    } else {
                        let parsed = typeof val === 'string' ? JSON.parse(val) : val;
                        if (Array.isArray(parsed)) {
                            data = decompressState(parsed);
                        } else if (parsed && typeof parsed === 'object') {
                            data = (parsed.q || parsed.queue) ? decompressState(parsed) : parsed;
                        }
                    }
                } catch (e) {
                    try {
                        const decoded = typeof val === 'string' ? safeDecode(val) : safeDecode(JSON.stringify(val));
                        const parsed = JSON.parse(decoded);
                        if (Array.isArray(parsed)) {
                            data = decompressState(parsed);
                        } else if (parsed && typeof parsed === 'object') {
                            data = (parsed.q || parsed.queue) ? decompressState(parsed) : parsed;
                        }
                    } catch (e2) {
                        try {
                            data = typeof val === 'string' ? JSON.parse(hexToString(val)) : val;
                        } catch (e3) {
                            try {
                                data = typeof val === 'string' ? JSON.parse(decodeURIComponent(val)) : val;
                            } catch (e4) {
                                try {
                                    data = typeof val === 'string' ? JSON.parse(val) : val;
                                } catch (e5) {
                                    return;
                                }
                            }
                        }
                    }
                }
                if (!isUpdatingNetwork && fetchStartTime >= lastWriteTime) {
                    if (validateState(data)) {
                        const isServerReset = data.ticketCounter === 1 && data.queue.length === 0;
                        const mergedQueue = isServerReset ? [] : mergeQueues(data.queue, state.queue, data.ticketCounter);
                        const mergedState = {
                            queue: mergedQueue,
                            ticketCounter: isServerReset ? 1 : Math.max(state.ticketCounter, data.ticketCounter),
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
        return fetch('/api/state')
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

    if (isCloudSyncActive && cloudRoomId) {
        isUpdatingNetwork = true;
        const trimmedState = getTrimmedState();
        db.collection('rooms').doc(cloudRoomId).set({
            queue: trimmedState.queue,
            ticketCounter: trimmedState.ticketCounter,
            avgWaitTimePerPerson: trimmedState.avgWaitTimePerPerson,
            activeEventId: activeEventId || null,
            activeEventName: activeEventName || 'ຍັງບໍ່ໄດ້ສ້າງງານ',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true })
        .then(() => {
            isUpdatingNetwork = false;
            lastWriteTime = Date.now();
            
            // Backup queue to the active event document so we can resume it later
            if (activeEventId) {
                db.collection('events').doc(activeEventId).update({
                    queueData: trimmedState.queue,
                    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                }).catch(() => {}); // ignore if it fails to avoid breaking UI
            }
        })
        .catch(err => {
            console.error('Firestore write failed:', err);
            isUpdatingNetwork = false;
        });
    } else {
        // Write to local python server fallback
        fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(state)
        }).catch(() => {});
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
    
    // Keep only the most recent completed/skipped items (say 10 items)
    const trimmedCompletedOrSkipped = completedOrSkipped.slice(0, 10);
    
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
    // Persist role in localStorage
    localStorage.setItem('snap_glow_device_role', role);

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
    
    // Adjust polling intervals for new role
    setupIntervals();
    
    // Re-render because TV view or operator view might have changed
    renderAll();
}

// -------------------------------------------------------------
// KIOSK REGISTRATION LOGIC
// -------------------------------------------------------------
function submitTicket() {
    // Staff presses button → go to package selection screen
    selectedPackage = null;
    selectedPayment = null;
    goToStep('package');
}

function openPaymentModal(pkgType) {
    selectedPackage = pkgType;
    const cfg = PACKAGE_CONFIG[pkgType];
    
    // Update modal content
    const nameEl = document.getElementById('modal-pkg-name');
    const priceEl = document.getElementById('modal-pkg-price');
    if (nameEl) nameEl.textContent = cfg ? cfg.label : '';
    if (priceEl) priceEl.textContent = cfg ? cfg.price.toLocaleString() + ' ກີບ' : '';
    
    // Show modal
    const modal = document.getElementById('payment-modal');
    if (modal) modal.classList.remove('hidden');
}

function closePaymentModal() {
    const modal = document.getElementById('payment-modal');
    if (modal) modal.classList.add('hidden');
}

function selectPaymentAndSubmit(method) {
    selectedPayment = method;
    closePaymentModal();
    confirmPackageAndIssue();
}

function confirmPackageAndIssue() {
    if (!selectedPackage || !selectedPayment) return;

    // Get latest counter from Firestore before issuing
    const getLatest = isCloudSyncActive && cloudRoomId
        ? db.collection('rooms').doc(cloudRoomId).get().then(snap => {
            if (snap.exists && snap.data().ticketCounter) {
                const serverCounter = snap.data().ticketCounter;
                if (serverCounter > state.ticketCounter) {
                    state.ticketCounter = serverCounter;
                }
            }
          })
        : Promise.resolve();

    getLatest.then(() => {
        const prefix = 'Q';
        const formattedNumber = `${prefix}-${String(state.ticketCounter).padStart(3, '0')}`;
        const timestampString = new Date().toLocaleTimeString('lo-LA', { hour: '2-digit', minute: '2-digit' });
        const cfg = PACKAGE_CONFIG[selectedPackage];

        const newQueueItem = {
            id: 'q_' + Date.now(),
            number: formattedNumber,
            status: 'waiting',
            timestamp: timestampString,
            rawTime: Date.now(),
            package: selectedPackage,
            paymentMethod: selectedPayment,
            price: cfg.price,
            packageLabel: cfg.label,
            eventId: activeEventId || 'no_event'
        };

        state.queue.push(newQueueItem);
        state.ticketCounter += 1;
        saveStateToStorage();

        // Also write ticket to Firestore events subcollection if event active
        if (activeEventId) {
            db.collection('events').doc(activeEventId)
              .collection('tickets').doc(newQueueItem.id)
              .set(newQueueItem).catch(() => {});
        }

        // Show ticket to customer
        const waitingItems = state.queue.filter(item => item.status === 'waiting');
        const waitTime = (waitingItems.length - 1) * state.avgWaitTimePerPerson;
        document.getElementById('ticket-display-number').textContent = formattedNumber;
        document.getElementById('ticket-display-wait').textContent = waitTime > 0 ? `${waitTime} ນາທີ` : 'ພ້ອມຖ່າຍທັນທີ';

        const badgeEl = document.getElementById('ticket-pkg-badge');
        if (badgeEl) badgeEl.textContent = cfg.label + ' — ' + cfg.price.toLocaleString() + ' ກີບ';

        playTicketBeep();
        goToStep('ticket');

        // Reset after 15s back to welcome
        setTimeout(() => goToStep('welcome'), 15000);
    }).catch(err => {
        console.error('Failed to issue ticket:', err);
    });
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
    const el = document.getElementById('step-' + step);
    if (el) {
        el.classList.remove('hidden');
        lucide.createIcons();
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
        
        // Execute callback immediately to prevent iOS Safari from blocking SpeechSynthesis (must be synchronous to user click)
        if (callback) callback();
        
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
    
    const kanyaVoice = availableVoices.find(v => v.name.toLowerCase().includes('kanya'));
    const thaiVoices = availableVoices.filter(v => v.lang.includes('th') || v.lang.includes('lo'));
    
    if (kanyaVoice) {
        const option = document.createElement('option');
        option.value = availableVoices.indexOf(kanyaVoice);
        option.textContent = `✅ ${kanyaVoice.name} (LOCKED)`;
        option.selected = true;
        select.appendChild(option);
    } else if (thaiVoices.length > 0) {
        thaiVoices.forEach((voice) => {
            const index = availableVoices.indexOf(voice);
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${voice.name} (${voice.lang})`;
            option.selected = true;
            select.appendChild(option);
        });
    } else {
        const defOpt = document.createElement('option');
        defOpt.value = 'default';
        defOpt.textContent = 'ບໍ່ພົບສຽງ Kanya ຫຼື ສຽງໄທໃນເຄື່ອງ';
        select.appendChild(defOpt);
    }
}

function speakTicket(ticketNumber) {
    if (!synth) return;
    // Removed synth.cancel() because it is known to break the speech queue on iOS Safari when called immediately before speak()
    const parts = ticketNumber.split('-');
    const letter = parts[0];
    const digits = parts[1].split('').join(' ');
    
    const select = document.getElementById('voice-select');
    let selectedVoiceIndex = select ? select.value : 'default';
    
    let chosenVoice = null;
    if (selectedVoiceIndex !== 'default') {
        chosenVoice = availableVoices[parseInt(selectedVoiceIndex)];
    } else {
        chosenVoice = availableVoices.find(v => v.name.toLowerCase().includes('kanya')) 
                   || availableVoices.find(v => v.lang.includes('th') || v.lang.includes('lo'));
    }
    
    // Force Thai announcement
    let announcementText = `ขอเชิญหมายเลขคิว ${letter} ${digits} ที่ห้องถ่ายภาพค่ะ`;
    
    const utterance = new SpeechSynthesisUtterance(announcementText);
    utterance.lang = 'th-TH'; // Explicitly set lang to fix iOS/Safari silence
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
        let badgeHtml = '';
        if (callingItem.package) {
            const pkgCfg = PACKAGE_CONFIG[callingItem.package];
            const badgeClass = callingItem.package === 'none' ? 'pkg-none' : (callingItem.package.includes('large') || callingItem.package === 'combo' ? 'pkg-large' : 'pkg-small');
            badgeHtml = pkgCfg ? `<div style="font-size: 1.5rem; margin-top: 10px;"><span class="pkg-badge ${badgeClass}" style="padding: 8px 16px; border-radius: 20px;">${pkgCfg.label}</span></div>` : '';
        }
        tvNumberBox.innerHTML = `<div class="serving-number-text">${callingItem.number}</div>${badgeHtml}`;
    } else {
        tvNumberBox.innerHTML = `<div class="serving-number-text">- - -</div>`;
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
        tvUpcomingContainer.innerHTML = waitingList.map((item, idx) => {
            let badgeHtml = '';
            if (item.package) {
                const pkgCfg = PACKAGE_CONFIG[item.package];
                const badgeClass = item.package === 'none' ? 'pkg-none' : (item.package.includes('large') || item.package === 'combo' ? 'pkg-large' : 'pkg-small');
                badgeHtml = pkgCfg ? `<span class="pkg-badge ${badgeClass}" style="margin-left: 8px;">${pkgCfg.label}</span>` : '';
            }
            return `
            <div class="upcoming-item" style="display:flex; justify-content:space-between; align-items:center;">
                <div class="item-left" style="display:flex; align-items:center;">
                    <div class="item-num">${item.number}</div>
                    ${badgeHtml}
                </div>
                <div class="item-right">
                    <span>${idx * state.avgWaitTimePerPerson} ນາທີ</span>
                </div>
            </div>
            `;
        }).join('');
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
        let badgeHtml = '';
        if (callingItem.package) {
            const pkgCfg = PACKAGE_CONFIG[callingItem.package];
            const badgeClass = callingItem.package === 'none' ? 'pkg-none' : (callingItem.package.includes('large') || callingItem.package === 'combo' ? 'pkg-large' : 'pkg-small');
            badgeHtml = pkgCfg ? ` <span class="pkg-badge ${badgeClass}" style="vertical-align: middle; margin-left: 10px; font-size: 0.9rem;">${pkgCfg.label}</span>` : '';
        }
        opActiveNum.innerHTML = callingItem.number + badgeHtml;
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
        waitingTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">ບໍ່ມີຄິວລໍຖ້າ</td></tr>`;
    } else {
        waitingTableBody.innerHTML = waitingList.map(item => {
            const pkgCfg = item.package ? PACKAGE_CONFIG[item.package] : null;
            const pkgBadge = pkgCfg
                ? `<span style="font-size: 0.85rem; font-weight: 600; padding: 4px 8px; border-radius: 6px; background: rgba(217,119,6,0.1); color: #d97706; border: 1px solid rgba(217,119,6,0.2); display: inline-block; white-space: nowrap;">${pkgCfg.label}</span>`
                : `<span style="opacity:0.3">—</span>`;
            const payBadge = item.paymentMethod === 'cash'
                ? `<span class="pay-badge pay-cash">💵</span>`
                : item.paymentMethod === 'transfer'
                ? `<span class="pay-badge pay-transfer">📲</span>`
                : `<span style="opacity:0.3">—</span>`;
            return `
            <tr>
                <td style="font-family: var(--font-outfit); font-weight: 700; font-size: 1.1rem; color: var(--text-main); vertical-align: middle;">${item.number}</td>
                <td style="color: var(--text-muted); vertical-align: middle;">${item.timestamp}</td>
                <td style="vertical-align: middle;">${pkgBadge}</td>
                <td style="vertical-align: middle;">${payBadge}</td>
                <td style="vertical-align: middle;">
                    <button class="op-table-btn skip" onclick="opSkip('${item.id}')" title="ຂ້າມຄິວ (Skip)">
                        <i data-lucide="user-x"></i>
                    </button>
                </td>
            </tr>`;
        }).join('');
    }
    
    const completedTableBody = document.getElementById('table-completed-body');
    if (completedList.length === 0) {
        completedTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">ບໍ່ມີປະຫວັດຄິວ</td></tr>`;
    } else {
        const sortedCompleted = [...completedList].sort((a, b) => b.rawTime - a.rawTime);
        completedTableBody.innerHTML = sortedCompleted.map(item => {
            const pkgCfg = item.package ? PACKAGE_CONFIG[item.package] : null;
            const pkgBadge = pkgCfg
                ? `<span style="font-size: 0.85rem; font-weight: 600; padding: 4px 8px; border-radius: 6px; background: rgba(217,119,6,0.1); color: #d97706; border: 1px solid rgba(217,119,6,0.2); display: inline-block; white-space: nowrap;">${pkgCfg.label}</span>`
                : `<span style="opacity:0.3">—</span>`;
            const payBadge = item.paymentMethod === 'cash'
                ? `<span class="pay-badge pay-cash">💵 ສົດ</span>`
                : item.paymentMethod === 'transfer'
                ? `<span class="pay-badge pay-transfer">📲 ໂອນ</span>`
                : `<span style="opacity:0.3">—</span>`;
            return `
            <tr>
                <td style="font-family: var(--font-outfit); font-weight: 700; color: var(--text-muted); vertical-align: middle;">${item.number}</td>
                <td style="vertical-align: middle;">${item.timestamp}</td>
                <td style="vertical-align: middle;">${pkgBadge}</td>
                <td style="vertical-align: middle;">${payBadge}</td>
                <td style="vertical-align: middle;">
                    <span style="color: ${item.status === 'completed' ? 'var(--neon-green)' : 'var(--neon-amber)'}; font-weight: 600;">
                        ${item.status === 'completed' ? 'ສຳເລັດ' : 'ຂ້າມ'}
                    </span>
                </td>
            </tr>`;
        }).join('');
    }

    // Revenue quick stat
    const validItems = state.queue.filter(i => i.package);
    const totalRevenue = validItems.reduce((sum, i) => sum + (i.price || 0), 0);
    const revEl = document.getElementById('op-revenue-total');
    if (revEl) revEl.textContent = totalRevenue.toLocaleString() + ' ກີບ';

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
function selectModalRole(role) {
    selectedModalRoleVal = role;
    
    // Update active styles on modal buttons
    document.querySelectorAll('.btn-role-select').forEach(btn => {
        btn.classList.remove('active');
        btn.style.border = '1px solid rgba(197, 160, 89, 0.3)';
        btn.style.background = 'rgba(255, 255, 255, 0.5)';
    });
    
    const activeBtn = document.getElementById(`modal-role-${role}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.style.border = 'transparent';
        activeBtn.style.background = 'var(--gradient-primary)';
    }
}

function openCloudModal() {
    const modal = document.getElementById('cloud-sync-modal');
    if (modal) {
        modal.classList.remove('hidden');
        
        // Pre-select the current active role in the modal
        const currentRole = getActiveRole().toLowerCase(); // 'kiosk', 'tv', or 'operator'
        selectModalRole(currentRole);
        
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

function resolveRoomBins(roomId) {
    const cachedBinId = localStorage.getItem('snap_glow_bin_id_' + roomId);
    const cachedPresenceBinId = localStorage.getItem('snap_glow_presence_bin_id_' + roomId);
    
    if (cachedBinId && cachedPresenceBinId) {
        return Promise.resolve({ cloudBinId: cachedBinId, presenceBinId: cachedPresenceBinId });
    }
    
    // Otherwise, fetch from master bin
    return fetch(`https://extendsclass.com/api/json-storage/bin/${MASTER_BIN_ID}`)
        .then(res => {
            if (!res.ok) throw new Error("Failed to read master database");
            return res.json();
        })
        .then(mapping => {
            const m = mapping || {};
            const qBinId = m[roomId];
            const pBinId = m[roomId + "_presence"];
            
            if (qBinId && pBinId) {
                // Cache and return
                localStorage.setItem('snap_glow_bin_id_' + roomId, qBinId);
                localStorage.setItem('snap_glow_presence_bin_id_' + roomId, pBinId);
                return { cloudBinId: qBinId, presenceBinId: pBinId };
            }
            
            // Create new bins if not found in master database
            const initialQueue = { value: compressCompactState(getTrimmedState()) };
            const initialPresence = { value: "" };
            
            // Helper to create a single bin
            const createBin = (data) => {
                return fetch('https://extendsclass.com/api/json-storage/bin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: JSON.stringify(data)
                })
                .then(r => {
                    if (!r.ok) throw new Error("Failed to create data slot");
                    return r.json();
                })
                .then(o => {
                    if (!o || !o.id) throw new Error("Missing data slot identifier");
                    return o.id;
                });
            };
            
            return createBin(initialQueue)
                .then(newQBinId => {
                    return createBin(initialPresence).then(newPBinId => {
                        // Register in master map
                        m[roomId] = newQBinId;
                        m[roomId + "_presence"] = newPBinId;
                        
                        return fetch(`https://extendsclass.com/api/json-storage/bin/${MASTER_BIN_ID}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'text/plain' },
                            body: JSON.stringify(m)
                        })
                        .then(updateRes => {
                            if (!updateRes.ok) throw new Error("Failed to register database slot");
                            
                            // Cache and return
                            localStorage.setItem('snap_glow_bin_id_' + roomId, newQBinId);
                            localStorage.setItem('snap_glow_presence_bin_id_' + roomId, newPBinId);
                            return { cloudBinId: newQBinId, presenceBinId: newPBinId };
                        });
                    });
                });
        });
}

function connectToCloudRoomById(targetRoomId) {
    if (!targetRoomId) return;

    // Show user a quick visual loading
    const activeIdText = document.getElementById('modal-active-room-id');
    if (activeIdText) activeIdText.textContent = "ກຳລັງເຊື່ອມຕໍ່ (ກວດສອບຖານຂໍ້ມູນ)...";

    // Set globals and persist
    cloudRoomId = targetRoomId;
    isCloudSyncActive = true;
    localStorage.setItem('snap_glow_cloud_room_id', targetRoomId);
    localStorage.setItem('snap_glow_cloud_sync_active', 'true');

    // Apply the selected role from the modal immediately
    if (typeof selectedModalRoleVal === 'string') {
        switchRole(selectedModalRoleVal);
    }

    // Subscribe to Firestore room
    subscribeToFirestoreRoom(targetRoomId);

    // Initial check: if room doesn't exist, create it with local state
    db.collection('rooms').doc(targetRoomId).get().then(snap => {
        if (!snap.exists) {
            saveStateToStorage();
            alert(`ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍສຳເລັດແລ້ວ! (ສ້າງຫ້ອງໃໝ່ "${targetRoomId}")`);
        } else {
            alert(`ເຊື່ອມຕໍ່ຫ້ອງອອນລາຍ "${targetRoomId}" ສຳເລັດແລ້ວ!`);
        }
    });

    updateCloudUI();
    renderAll();
    updateModalState();
    syncDevicePresence();
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
    
    if (!presenceBinId) return; // Skip if presence bin ID is not resolved yet
    
    fetch(`https://extendsclass.com/api/json-storage/bin/${presenceBinId}?t=${Date.now()}`)
        .then(res => {
            if (!res.ok) return null;
            return res.json();
        })
        .then(resObj => {
            const val = (resObj && typeof resObj === 'object' && resObj.value !== undefined) ? resObj.value : resObj;
            let presenceMap = {};
            if (val) {
                try {
                    const decoded = typeof val === 'string' ? safeDecode(val) : safeDecode(JSON.stringify(val));
                    const parsed = JSON.parse(decoded);
                    if (Array.isArray(parsed)) {
                        presenceMap = decompressPresence(parsed);
                    } else {
                        presenceMap = parsed;
                    }
                } catch (e) {
                    try {
                        presenceMap = typeof val === 'string' ? JSON.parse(hexToString(val)) : val;
                    } catch(e2) {
                        try {
                            presenceMap = typeof val === 'string' ? JSON.parse(decodeURIComponent(val)) : val;
                        } catch(e3) {
                            try {
                                presenceMap = typeof val === 'string' ? JSON.parse(val) : val;
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
                if (Math.abs(now - presenceMap[devId].lastSeen) < 600000) {
                    activeMap[devId] = presenceMap[devId];
                    count++;
                }
            }
            
            activeDevicesCount = count;
            updatePresenceUI(activeMap);
            
            const compressed = compressPresence(activeMap);
            const valToSend = safeEncode(JSON.stringify(compressed));
            
            // Write updated presence to extendsclass.com JSON Storage
            fetch(`https://extendsclass.com/api/json-storage/bin/${presenceBinId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify({ value: valToSend })
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

// Base-36 utilities for ultra-compact URL segment transfer (safely fits 50+ tickets under IIS 260-char limit)
function toBase36(num, length) {
    let str = parseInt(num || 0, 10).toString(36);
    return str.padStart(length, '0');
}

function fromBase36(str) {
    if (!str) return 0;
    return parseInt(str, 36) || 0;
}

function compressCompactState(fullState) {
    const arr = compressState(fullState);
    if (!arr || arr.length < 4) return '';
    
    let str = 'v'; // Version 2 prefix to distinguish from old 4-character time format
    str += toBase36(arr[0], 2); // ticketCounter (0-1295) -> 2 chars
    str += toBase36(arr[1], 1); // avgWaitTimePerPerson (0-35) -> 1 char
    str += toBase36(arr[2], 2); // calling ticket number (0-1295) -> 2 chars
    str += toBase36(arr[3], 3); // calling ticket check-in time (0-46655) -> 3 chars (for 0-1440 min)
    
    for (let i = 4; i < arr.length; i += 2) {
        str += toBase36(arr[i], 2);   // waiting ticket number -> 2 chars
        str += toBase36(arr[i+1], 3); // waiting ticket time -> 3 chars
    }
    return str;
}

function decompressCompactState(str) {
    if (!str || typeof str !== 'string') return null;
    
    if (str.startsWith('v')) {
        // Version 2: 3-character time, 2-character ticket numbers
        const payload = str.substring(1);
        if (!/^[0-9a-z]+$/.test(payload) || payload.length < 8) return null;
        
        const ticketCounter = fromBase36(payload.substring(0, 2));
        const avgWaitTimePerPerson = fromBase36(payload.substring(2, 3));
        const callingNum = fromBase36(payload.substring(3, 5));
        const callingTime = fromBase36(payload.substring(5, 8));
        
        const arr = [
            ticketCounter,
            avgWaitTimePerPerson,
            callingNum,
            callingTime
        ];
        
        for (let i = 8; i + 5 <= payload.length; i += 5) {
            const numVal = fromBase36(payload.substring(i, i + 2));
            const timeVal = fromBase36(payload.substring(i + 2, i + 5));
            arr.push(numVal, timeVal);
        }
        
        return decompressState(arr);
    } else {
        // Version 1 (Backward Compatibility): Old 2-character time format
        if (!/^[0-9a-z]+$/.test(str) || str.length < 7) return null;
        
        const ticketCounter = fromBase36(str.substring(0, 2));
        const avgWaitTimePerPerson = fromBase36(str.substring(2, 3));
        const callingNum = fromBase36(str.substring(3, 5));
        const callingTime = fromBase36(str.substring(5, 7));
        
        const arr = [
            ticketCounter,
            avgWaitTimePerPerson,
            callingNum,
            callingTime
        ];
        
        for (let i = 7; i + 4 <= str.length; i += 4) {
            const numVal = fromBase36(str.substring(i, i + 2));
            const timeVal = fromBase36(str.substring(i + 2, i + 4));
            arr.push(numVal, timeVal);
        }
        
        return decompressState(arr);
    }
}

// Highly compact representation for cloud synchronization (keeps segment size < 260 characters)
function compressState(fullState) {
    const arr = [
        fullState.ticketCounter || 1,
        fullState.avgWaitTimePerPerson || 5,
        0, // calling ticket number
        0  // calling ticket check-in time
    ];
    
    if (fullState.queue && Array.isArray(fullState.queue)) {
        const waitingTickets = fullState.queue.filter(item => item.status === 'waiting');
        const callingTicket = fullState.queue.find(item => item.status === 'calling');
        
        if (callingTicket) {
            const numMatch = callingTicket.number ? callingTicket.number.match(/\d+/) : null;
            arr[2] = numMatch ? parseInt(numMatch[0], 10) : 0;
            arr[3] = timeToMinutes(callingTicket.timestamp);
        }
        
        waitingTickets.forEach(item => {
            const numMatch = item.number ? item.number.match(/\d+/) : null;
            const numVal = numMatch ? parseInt(numMatch[0], 10) : 0;
            const timeVal = timeToMinutes(item.timestamp);
            arr.push(numVal, timeVal);
        });
    }
    return arr;
}

function decompressState(arr) {
    if (!arr || !Array.isArray(arr)) return null;
    
    // Check if it's the old compressed object format with 'q'
    if (arr.q !== undefined) {
        return decompressLegacyState(arr);
    }
    
    // Check if it's the old array-of-arrays format
    if (arr.length > 0 && Array.isArray(arr[0])) {
        return decompressLegacyState({ q: arr });
    }
    
    if (arr.length < 4) return null;
    
    const full = {
        queue: [],
        ticketCounter: parseInt(arr[0], 10) || 1,
        avgWaitTimePerPerson: parseInt(arr[1], 10) || 5
    };
    
    function minutesToTime(mins) {
        if (!mins) {
            const now = new Date();
            return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        }
        const h = Math.floor(mins / 60) % 24;
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    
    const callingNum = parseInt(arr[2], 10);
    const callingTime = parseInt(arr[3], 10);
    if (callingNum) {
        const formattedNumber = `Q-${String(callingNum).padStart(3, '0')}`;
        full.queue.push({
            id: 'q_call_' + callingNum,
            number: formattedNumber,
            status: 'calling',
            timestamp: minutesToTime(callingTime),
            completedAt: '',
            rawTime: Date.now()
        });
    }
    
    for (let i = 4; i < arr.length; i += 2) {
        const numVal = parseInt(arr[i], 10);
        const timeVal = parseInt(arr[i+1], 10);
        if (numVal === undefined || isNaN(numVal)) break;
        
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
    
    return full;
}

function decompressLegacyState(comp) {
    const full = {
        queue: [],
        ticketCounter: comp.tc || 1,
        avgWaitTimePerPerson: comp.wt || 5
    };
    
    const queueList = comp.q || comp.queue || [];
    if (Array.isArray(queueList)) {
        full.queue = queueList.map(arr => {
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
function compressPresence(presenceMap) {
    const arr = [];
    const now = Date.now();
    for (const devId in presenceMap) {
        if (Math.abs(now - presenceMap[devId].lastSeen) < 600000) {
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

// -------------------------------------------------------------
// ADMIN PANEL & EVENT MANAGEMENT LOGIC
// -------------------------------------------------------------
function openAdminPanel() {
    document.getElementById('admin-modal').classList.remove('hidden');
    adminPinEntry = '';
    updatePinDots();
    document.getElementById('pin-error').classList.add('hidden');
    document.getElementById('admin-pin-screen').classList.remove('hidden');
    document.getElementById('admin-dashboard').classList.add('hidden');
}

function closeAdminPanel() {
    document.getElementById('admin-modal').classList.add('hidden');
}

function pinInput(num) {
    if (adminPinEntry.length < 4) {
        adminPinEntry += num;
        updatePinDots();
    }
}

function pinClear() {
    adminPinEntry = adminPinEntry.slice(0, -1);
    updatePinDots();
}

function updatePinDots() {
    for (let i = 0; i < 4; i++) {
        const dot = document.getElementById(`dot-${i}`);
        if (dot) {
            if (i < adminPinEntry.length) dot.classList.add('active');
            else dot.classList.remove('active');
        }
    }
}

function pinSubmit() {
    if (adminPinEntry === ADMIN_PIN) {
        document.getElementById('admin-pin-screen').classList.add('hidden');
        document.getElementById('admin-dashboard').classList.remove('hidden');
        loadAdminDashboard();
    } else {
        document.getElementById('pin-error').classList.remove('hidden');
        adminPinEntry = '';
        updatePinDots();
    }
}

function showCreateEvent() {
    document.getElementById('create-event-form').classList.remove('hidden');
}

function hideCreateEvent() {
    document.getElementById('create-event-form').classList.add('hidden');
    document.getElementById('new-event-name').value = '';
}

function ensureActiveEvent() {
    if (!activeEventId) {
        activeEventId = 'event_' + Date.now();
        activeEventName = 'ງານທົ່ວໄປ (Default)';
        localStorage.setItem('snap_glow_active_event_id', activeEventId);
        localStorage.setItem('snap_glow_active_event_name', activeEventName);
    }
}

function createNewEvent() {
    const nameInput = document.getElementById('new-event-name').value.trim();
    if (!nameInput) {
        alert("ກະລຸນາໃສ່ຊື່ງານ (Please enter event name)");
        return;
    }

    if (!confirm(`ທ່ານຕ້ອງການປິດງານເກົ່າ ແລະ ເລີ່ມງານໃໝ່ "${nameInput}" ໂດຍລີເຊັດຄິວກັບໄປທີ່ Q-001 ແທ້ບໍ່?`)) {
        return;
    }

    // 1. Calculate revenue for the CURRENT (old) event before archiving
    let totalRev = 0, cashRev = 0, transferRev = 0;
    let counts = { none: 0, large: 0, small2: 0, combo: 0, large2: 0 };
    state.queue.forEach(item => {
        // Count all tickets, including skipped ones
        if (item.package) {
            totalRev += (item.price || 0);
            if (item.paymentMethod === 'cash') cashRev += (item.price || 0);
            if (item.paymentMethod === 'transfer') transferRev += (item.price || 0);
            if (counts[item.package] !== undefined) counts[item.package]++;
        }
    });

    const oldEventId = activeEventId;

    // 2. Set new active event
    activeEventId = 'event_' + Date.now();
    activeEventName = nameInput;
    localStorage.setItem('snap_glow_active_event_id', activeEventId);
    localStorage.setItem('snap_glow_active_event_name', activeEventName);
    
    if (isCloudSyncActive && cloudRoomId) {
        // Save old event final stats
        if (oldEventId) {
            db.collection('events').doc(oldEventId).set({
                revenue: { total: totalRev, cash: cashRev, transfer: transferRev, counts: counts },
                endedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(() => {});
        }
        
        // Save new event metadata
        db.collection('events').doc(activeEventId).set({
            name: activeEventName,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            roomId: cloudRoomId
        }).catch(() => {});
    }

    // Reset local queue completely and push new event info to cloud room
    resetState();
    saveStateToStorage();
    
    hideCreateEvent();
    alert(`ສ້າງງານໃໝ່ "${activeEventName}" ສຳເລັດ! ເລີ່ມຄິວໃໝ່ແລ້ວ.`);
    
    // Wait briefly for Firestore to index the new event before reloading history
    setTimeout(() => {
        loadAdminDashboard();
        renderAll();
    }, 1000);
}

function loadAdminDashboard() {
    // 0. Update active group UI
    const groupEl = document.getElementById('admin-current-group');
    const groupSel = document.getElementById('admin-group-select');
    if (groupEl && groupSel) {
        groupEl.textContent = cloudRoomId || 'None';
        if (['group1', 'group2', 'group3'].includes(cloudRoomId)) {
            groupSel.value = cloudRoomId;
        } else {
            // If it's a custom room ID, we could add it dynamically, but for now just clear selection
            groupSel.value = '';
        }
    }

    // 1. Update active event info
    document.getElementById('admin-active-event-name').textContent = activeEventName;
    document.getElementById('admin-active-event-date').textContent = "ID: " + (activeEventId || 'None');

    // 2. Load revenue
    let totalRev = 0, cashRev = 0, transferRev = 0;
    let counts = { none: 0, large: 0, small2: 0, combo: 0, large2: 0 };
    let revs = { none: 0, large: 0, small2: 0, combo: 0, large2: 0 };

    state.queue.forEach(item => {
        // Count all issued tickets in revenue, even if they were skipped, because payment is collected upfront
        if (item.package) {
            totalRev += (item.price || 0);
            if (item.paymentMethod === 'cash') cashRev += (item.price || 0);
            if (item.paymentMethod === 'transfer') transferRev += (item.price || 0);

            if (counts[item.package] !== undefined) {
                counts[item.package]++;
                revs[item.package] += (item.price || 0);
            }
        }
    });

    document.getElementById('adm-rev-total').textContent = totalRev.toLocaleString() + ' ກີບ';
    document.getElementById('adm-rev-cash').textContent = cashRev.toLocaleString() + ' ກີບ';
    document.getElementById('adm-rev-transfer').textContent = transferRev.toLocaleString() + ' ກີບ';

    document.getElementById('adm-rev-none').textContent = `${counts.none} ຄິວ — ${revs.none.toLocaleString()} ກີບ`;
    document.getElementById('adm-rev-large').textContent = `${counts.large} ຄິວ — ${revs.large.toLocaleString()} ກີບ`;
    document.getElementById('adm-rev-small2').textContent = `${counts.small2} ຄິວ — ${revs.small2.toLocaleString()} ກີບ`;
    document.getElementById('adm-rev-combo').textContent = `${counts.combo} ຄິວ — ${revs.combo.toLocaleString()} ກີບ`;
    document.getElementById('adm-rev-large2').textContent = `${counts.large2} ຄິວ — ${revs.large2.toLocaleString()} ກີບ`;

    // 3. Load past events from firestore
    const historyDiv = document.getElementById('admin-event-history');
    if (isCloudSyncActive && cloudRoomId) {
        db.collection('events').where('roomId', '==', cloudRoomId).orderBy('createdAt', 'desc').limit(10).get()
        .then(snap => {
            if (snap.empty) {
                historyDiv.innerHTML = '<p style="color:var(--text-muted)">ບໍ່ມີປະຫວັດງານເກົ່າ</p>';
                return;
            }
            let html = '<ul class="history-list">';
            snap.forEach(doc => {
                const d = doc.data();
                const dateStr = d.createdAt ? d.createdAt.toDate().toLocaleDateString('lo-LA') : 'Unknown Date';
                const isActive = doc.id === activeEventId;
                const revText = isActive 
                    ? `ລາຍຮັບ: ${totalRev.toLocaleString()} ກີບ`
                    : (d.revenue ? `ລາຍຮັບ: ${d.revenue.total.toLocaleString()} ກີບ` : 'ບໍ່ມີຂໍ້ມູນລາຍຮັບ');
                html += `<li>
                    <div style="display:flex; justify-content: space-between; align-items:center; width: 100%;">
                        <div>
                            <strong>${d.name}</strong> <span style="font-size:0.8rem; color:var(--text-muted)">(${dateStr})</span>
                            <div style="font-size: 0.85rem; color: #10b981; margin-top: 4px;">${revText}</div>
                        </div>
                        <div>
                            ${isActive ? '<span class="pkg-badge pkg-large">ກຳລັງໃຊ້ງານ</span>' : `<button class="btn btn-secondary btn-sm" onclick="resumeEvent('${doc.id}')" style="font-size: 0.8rem; padding: 4px 10px; border-radius: 6px;"><i data-lucide="play" style="width: 14px; height: 14px;"></i> ເລືອກງານນີ້</button>`}
                        </div>
                    </div>
                </li>`;
            });
            html += '</ul>';
            historyDiv.innerHTML = html;
            lucide.createIcons(); // refresh icons
        }).catch(e => {
            historyDiv.innerHTML = `<p style="color:red">Failed to load history: ${e.message}</p>`;
        });
    } else {
        historyDiv.innerHTML = '<p style="color:var(--text-muted)">Cloud Sync ຖືກປິດ. ບໍ່ສາມາດດຶງປະຫວັດໄດ້.</p>';
    }
}

// ---------------------------------------------------------------------------
// ADMIN ACTIONS
// ---------------------------------------------------------------------------

function adminClearQueue() {
    if (!confirm('ທ່ານແນ່ໃຈບໍ່ວ່າຕ້ອງການລຶບຄິວທັງໝົດໃນງານນີ້? (ນີ້ຈະລຶບຄິວທີ່ກຳລັງລໍຖ້າ ແລະສຳເລັດແລ້ວທັງໝົດ, ແຕ່ຈະບໍ່ລຶບງານ)')) return;
    
    // reset state properly and sync to cloud (saveStateToStorage also handles event backups)
    resetState();
    saveStateToStorage();
    
    alert('ລຶບຄິວສຳເລັດ!');
    loadAdminDashboard();
    renderAll();
}

function resumeEvent(eventId) {
    if (!confirm('ຕ້ອງການເລືອກງານນີ້ມາເປັນງານປັດຈຸບັນ ແລະ ໂຫຼດຄິວເກົ່າມາໃຊ້ຕໍ່ບໍ່?')) return;
    
    db.collection('events').doc(eventId).get().then(doc => {
        if (!doc.exists) {
            alert('ບໍ່ພົບຂໍ້ມູນງານນີ້');
            return;
        }
        
        const data = doc.data();
        activeEventId = doc.id;
        localStorage.setItem('snap_glow_active_event_id', activeEventId);
        activeEventName = data.name || 'ບໍ່ມີຊື່';
        localStorage.setItem('snap_glow_active_event_name', activeEventName);
        
        state.queue = data.queueData || [];
        
        // Find highest ticket number to resume counter
        let maxTick = 0;
        state.queue.forEach(t => {
            const num = parseInt(t.number.replace('Q-',''), 10);
            if (!isNaN(num) && num > maxTick) maxTick = num;
        });
        state.ticketCounter = maxTick + 1;
        
        saveStateToStorage();
        alert('ໂຫຼດງານສຳເລັດ! ກັບໄປໜ້າ Operator ເພື່ອສືບຕໍ່.');
        loadAdminDashboard();
        renderAll();
    }).catch(e => {
        alert('ເກີດຂໍ້ຜິດພາດ: ' + e.message);
    });
}

function adminSwitchGroup(groupId) {
    if (!groupId) return;
    
    // Clear local active event so it doesn't leak between groups
    activeEventId = null;
    activeEventName = 'ຍັງບໍ່ໄດ້ສ້າງງານ';
    localStorage.removeItem('snap_glow_active_event_id');
    localStorage.removeItem('snap_glow_active_event_name');

    // Connect to the new group
    connectToCloudRoomById(groupId);
    
    // Wait briefly for firestore listener to attach and then reload dashboard
    setTimeout(() => {
        loadAdminDashboard();
        renderAll();
    }, 500);
}
