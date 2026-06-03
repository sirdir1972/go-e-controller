const axios = require('axios');

// Central configuration object
const ConfigData = {
    goeIP: "#GOE-IP#",
    statePath: "0_userdata.0.go-e.",
    smartMeterDP: "#TotalActivePower#",
    pvDP: "#totalSolar#",
    batteryDP: "#totalBatteryOutput#",
    controllerUpdateIntervalMs: 5000,   // Interval for sending Grid/PV/Battery to wallbox
    statusUpdateIntervalMs: 10000,      // Interval for polling wallbox status data
    nightChargeStartHour: 0,            // Start hour for night charging (24h format)
    nightChargeEndHour: 8               // End hour for night charging (24h format)
};

// Global interval references and tracking variables
let controllerInterval = null;
let statusInterval = null;
let nightChargeInterval = null;
let wasNightCharged = false;

// --- Helper Functions ---

function logDebug(message) {
    if (existsState(ConfigData.statePath + 'Debug') && getState(ConfigData.statePath + 'Debug').val) {
        log('[go-e Debug] ' + message, 'info');
    }
}

function getStateVal(id, fallback) {
    if (!existsState(id)) return fallback;
    const state = getState(id);
    return (state && state.val !== null && state.val !== undefined) ? state.val : fallback;
}

// Standard API Call for normal parameters
async function setGoeAPI(params) {
    try {
        const query = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
        const url = `http://${ConfigData.goeIP}/api/set?${query}`;
        
        logDebug(`Sending HTTP Request (SET): ${url}`);
        const response = await axios.get(url);
        logDebug(`HTTP Response (SET): ${JSON.stringify(response.data)}`);
        
        return response.data;
    } catch (error) {
        log(`[go-e Error] API set call failed: ${error.message}`, 'error');
    }
}

// API Call specifically for reading status
async function getGoeAPI(filter) {
    try {
        const url = `http://${ConfigData.goeIP}/api/status?filter=${filter}`;
        
        logDebug(`Sending HTTP Request (GET): ${url}`);
        const response = await axios.get(url);
        logDebug(`HTTP Response (GET): ${JSON.stringify(response.data)}`);
        
        return response.data;
    } catch (error) {
        log(`[go-e Error] API status read failed: ${error.message}`, 'error');
        return null;
    }
}

// --- Core Logic (Save & Restore State) ---

async function saveGoeState() {
    logDebug("Reading current amp and dwo limits from wallbox to back them up...");
    const data = await getGoeAPI('amp,dwo');
    
    if (data) {
        const amp = data.amp !== undefined ? data.amp : 16;
        const dwo = (data.dwo !== undefined && data.dwo !== null) ? data.dwo : 0;
        
        setState(ConfigData.statePath + 'oldPower', amp, true);
        setState(ConfigData.statePath + 'oldkWh', dwo, true);
        logDebug(`State backed up successfully - Amp: ${amp}, Limit (dwo): ${dwo}`);
    }
}

async function restoreGoeState() {
    logDebug("Restoring previous amp and dwo limits to the wallbox...");
    const amp = getStateVal(ConfigData.statePath + 'oldPower', 16);
    const dwo = getStateVal(ConfigData.statePath + 'oldkWh', 0);
    
    const params = { amp: amp };
    params.dwo = (dwo && dwo > 0) ? dwo : 0; 
    
    logDebug(`Restoring values - Amp: ${amp}, Limit (dwo): ${dwo}`);
    await setGoeAPI(params);
}

// --- Polling & Timer Management ---

// Virtual Controller: Sends Grid, PV, and Battery data continuously
function startVirtualController() {
    if (controllerInterval) clearInterval(controllerInterval);
    
    controllerInterval = setInterval(async () => {
        const grid = Math.round(getStateVal(ConfigData.smartMeterDP, 0));
        const pv = Math.round(getStateVal(ConfigData.pvDP, 0));
        const battery = Math.round(getStateVal(ConfigData.batteryDP, 0));

        logDebug(`Sending virtual controller data: Grid=${grid}W, PV=${pv}W, Akku=${battery}W`);
        
        const payload = {
            "pGrid": grid,
            "pPv": pv,
            "pAkku": battery
        };

        const url = `http://${ConfigData.goeIP}/api/set?ids=${JSON.stringify(payload)}`;
        try {
            await axios.get(url);
        } catch (error) {
            log(`[go-e Error] API set virtual controller failed: ${error.message}`, 'error');
        }
    }, ConfigData.controllerUpdateIntervalMs);
    
    logDebug("Virtual controller interval started (continuous updates).");
}

// Regular status polling for wallbox telemetry
function startStatusPolling() {
    if (statusInterval) clearInterval(statusInterval);
    
    statusInterval = setInterval(async () => {
        logDebug("Polling regular status data from go-e charger...");
        const data = await getGoeAPI('car,nrg,wh');
        
        if (data) {
            const carStatus = data.car !== undefined ? data.car : 1;
            setState(ConfigData.statePath + 'car', carStatus, true);
            
            const wh = data.wh !== undefined ? data.wh : 0;
            setState(ConfigData.statePath + 'charged_kWh', wh / 1000, true);
            
            if (data.nrg && Array.isArray(data.nrg)) {
                const currentL1 = data.nrg[4] !== undefined ? data.nrg[4] : 0;
                const totalPower = data.nrg[11] !== undefined ? data.nrg[11] : 0;
                
                setState(ConfigData.statePath + 'currentAmpsL1', currentL1, true);
                setState(ConfigData.statePath + 'Power', totalPower, true);
                
                const isCharging = totalPower > 100 || carStatus === 2;
                setState(ConfigData.statePath + 'charging', isCharging, true);
                setState(ConfigData.statePath + 'charging_string', isCharging ? 'On' : 'Off', true);
            }
        }
    }, ConfigData.statusUpdateIntervalMs);
    
    logDebug("Wallbox telemetry status polling started.");
}

// Night charging scheduler logic
function startNightChargeScheduler() {
    if (nightChargeInterval) clearInterval(nightChargeInterval);
    
    nightChargeInterval = setInterval(() => {
        const isNightChargeEnabled = getStateVal(ConfigData.statePath + 'instaChargeAtNight', false);
        if (!isNightChargeEnabled) {
            if (wasNightCharged) {
                wasNightCharged = false;
                setState(ConfigData.statePath + 'instaCharge', false, false);
            }
            return;
        }
        
        const now = new Date();
        const hour = now.getHours();
        const start = ConfigData.nightChargeStartHour;
        const end = ConfigData.nightChargeEndHour;
        
        let inWindow = false;
        if (start < end) {
            inWindow = (hour >= start && hour < end);
        } else {
            inWindow = (hour >= start || hour < end);
        }
        
        if (inWindow) {
            if (!getStateVal(ConfigData.statePath + 'instaCharge', false)) {
                logDebug("Night charging time window reached. Activating instaCharge...");
                wasNightCharged = true;
                setState(ConfigData.statePath + 'instaCharge', true, false);
            }
        } else {
            if (wasNightCharged && getStateVal(ConfigData.statePath + 'instaCharge', false)) {
                logDebug("Night charging time window ended. Deactivating instaCharge...");
                wasNightCharged = false;
                setState(ConfigData.statePath + 'instaCharge', false, false);
            }
        }
    }, 60000);
}

// --- Handler Functions ---

async function handleControlMode(isActive) {
    if (isActive) {
        if (getStateVal(ConfigData.statePath + 'control', false) === true) {
            setState(ConfigData.statePath + 'instaCharge', false, true);
        }
        await saveGoeState();
        
        // Auto-Profil basierend auf deinem Datenpunkt ermitteln
        const isZoe = getStateVal(ConfigData.statePath + 'Zoe', false);
        const minCurrent = isZoe ? 7 : 6;
        const simulateUnplug = isZoe ? true : false;
        
        // Zwingt die Wallbox in den Eco-Modus inkl. passender Auto-Parameter (mca und su)
        await setGoeAPI({ frc: 0, lmo: 4, fup: true, mca: minCurrent, su: simulateUnplug });
        
        logDebug(`Mode active: Excess Charging (isZoe=${isZoe}, mca=${minCurrent}A, su=${simulateUnplug}).`);
    } else {
        await setGoeAPI({ frc: 1 });
        await restoreGoeState();
        logDebug("Mode active: Charging stopped (frc=1). Restored defaults.");
    }
}

async function handleInstaChargeMode(isActive) {
    if (isActive) {
        if (getStateVal(ConfigData.statePath + 'control', false) === true) {
            setState(ConfigData.statePath + 'control', false, true);
        }
        await restoreGoeState(); 
        await setGoeAPI({ frc: 2 });
        logDebug("Mode active: Instant Charge (frc=2). Original limits applied.");
    } else {
        if (getStateVal(ConfigData.statePath + 'control', false) === false) {
            await setGoeAPI({ frc: 1 });
            logDebug("Mode: Instant Charge deactivated, charging stopped (frc=1).");
        }
    }
}

// --- Event Listeners for ioBroker States ---

on({ id: ConfigData.statePath + 'control', change: 'ne' }, async function (obj) {
    try {
        logDebug(`Trigger fired: 'control' changed to ${obj.state.val}.`);
        await handleControlMode(obj.state.val);
    } catch (err) {
        log(`[go-e Error] Critical error in control trigger: ${err.message}`, 'error');
    }
});

on({ id: ConfigData.statePath + 'instaCharge', change: 'ne' }, async function (obj) {
    try {
        logDebug(`Trigger fired: 'instaCharge' changed to ${obj.state.val}.`);
        await handleInstaChargeMode(obj.state.val);
    } catch (err) {
        log(`[go-e Error] Critical error in instaCharge trigger: ${err.message}`, 'error');
    }
});

// Trigger: Fahrzeugwechsel (Zoe / Kona) im laufenden Betrieb
on({ id: ConfigData.statePath + 'Zoe', change: 'ne' }, async function (obj) {
    try {
        logDebug(`Trigger fired: 'Zoe' changed to ${obj.state.val}.`);
        // Wenn Überschussladen aktiv ist, pushen wir die neuen Auto-Parameter direkt in die Wallbox
        if (getStateVal(ConfigData.statePath + 'control', false) === true) {
            await handleControlMode(true);
        }
    } catch (err) {
        log(`[go-e Error] Critical error in Zoe trigger: ${err.message}`, 'error');
    }
});

// --- Initialization ---

async function init() {
    await createStateAsync(ConfigData.statePath + 'control', false, { type: 'boolean', name: 'Überschussladen (Eco)', role: 'switch', read: true, write: true });
    await createStateAsync(ConfigData.statePath + 'instaCharge', false, { type: 'boolean', name: 'Sofortladen (InstaCharge)', role: 'switch', read: true, write: true });
    await createStateAsync(ConfigData.statePath + 'instaChargeAtNight', false, { type: 'boolean', name: 'Sofortladen in der Nacht (0-8 Uhr)', role: 'switch', read: true, write: true });
    await createStateAsync(ConfigData.statePath + 'Zoe', false, { type: 'boolean', name: 'Fahrzeug ist Renault Zoe', role: 'switch', read: true, write: true });
    await createStateAsync(ConfigData.statePath + 'Debug', false, { type: 'boolean', name: 'Debug Logging aktivieren', role: 'switch', read: true, write: true });
    
    await createStateAsync(ConfigData.statePath + 'oldPower', 16, { type: 'number', name: 'Zuletzt eingestellte Ampere', role: 'value', read: true, write: false });
    await createStateAsync(ConfigData.statePath + 'oldkWh', 0, { type: 'number', name: 'Zuletzt eingestelltes kWh Limit (dwo)', role: 'value', read: true, write: false });
    
    await createStateAsync(ConfigData.statePath + 'Power', 0, { type: 'number', name: 'Aktuelle Ladeleistung in Watt', role: 'value.power', read: true, write: false });
    await createStateAsync(ConfigData.statePath + 'charged_kWh', 0, { type: 'number', name: 'Geladene kWh seit Einstecken', role: 'value', read: true, write: false });
    await createStateAsync(ConfigData.statePath + 'charging', false, { type: 'boolean', name: 'Auto lädt', role: 'value', read: true, write: false });
    await createStateAsync(ConfigData.statePath + 'charging_string', 'Off', { type: 'string', name: 'Auto lädt (On/Off)', role: 'value', read: true, write: false });
    await createStateAsync(ConfigData.statePath + 'currentAmpsL1', 0, { type: 'number', name: 'Stromstärke auf L1', role: 'value.current', read: true, write: false });
    await createStateAsync(ConfigData.statePath + 'car', 1, { type: 'number', name: 'Fahrzeug Status ID', role: 'value', read: true, write: false });
    
    if (getStateVal(ConfigData.statePath + 'Debug', false)) {
        log('[go-e Debug] Script successfully started. All internal states initialized.', 'info');
    }
    
    // Start continuous tasks
    startVirtualController();
    startStatusPolling();
    startNightChargeScheduler();

    // Check and apply initial states
    const initialControl = getStateVal(ConfigData.statePath + 'control', false);
    const initialInstaCharge = getStateVal(ConfigData.statePath + 'instaCharge', false);

    if (initialControl) {
        logDebug("Startup-Check: 'control' is already true. Applying logic...");
        await handleControlMode(true);
    } else if (initialInstaCharge) {
        logDebug("Startup-Check: 'instaCharge' is already true. Applying logic...");
        await handleInstaChargeMode(true);
    }
}

init();
