const logEl = document.getElementById('log')
const appendLog = (s) => { if (!logEl) return; logEl.textContent += s + '\n'; logEl.scrollTop = logEl.scrollHeight }

let cachedBaseUrl = null
let cachedListUrl = null
let settings = null
let allowedDirsList = null
let cachedRemote = null
let cachedJarUrl = null
let jarURL = null;

async function loadSettings() {
  settings = await window.electronAPI.settingsGet()
  if (!settings) settings = {}
  console.log(settings);
  // ensure keys exist
  settings.minecraftPath = settings.minecraftPath || ''
  settings.folderName = settings.folderName || ''
  settings.javaPath = settings.javaPath || null
  settings.ram = settings.ram || 4096
  settings.username = settings.username || ''
  return settings
}

async function saveSettings() {
  if (!settings) return
  await window.electronAPI.settingsSet(settings)
}

loadSettings().then(() => appendLog('Settings loaded'))

// After settings load, initialize RAM input when possible
async function initRamInput() {
  try {
    const ramEl = document.getElementById('ram')
    const ramNote = document.getElementById('ramNote')
    if (!ramEl) return
    // ask main for system memory
    const mem = await window.electronAPI.getSystemMemory()
    const totalMB = (mem && mem.success) ? (mem.totalMB || 4096) : 4096
    const maxAllowed = Math.max(1024, Math.floor(totalMB * 0.9)) // leave headroom
    ramEl.max = String(maxAllowed)
    if (ramNote) ramNote.textContent = `Max détecté: ${totalMB} MB (sélection recommandée ≤ ${maxAllowed} MB)`
    // fill with saved setting
    settings = settings || await loadSettings()
    const saved = settings.ram || 4096
    // clamp saved value
    const clamped = Math.min(Math.max(parseInt(saved || 4096, 10) || 4096, 512), maxAllowed)
    ramEl.value = String(clamped)

    // persist on change
    ramEl.addEventListener('change', async () => {
      const v = parseInt(ramEl.value || '0', 10) || 4096
      settings = settings || await loadSettings()
      settings.ram = Math.min(Math.max(v, 512), maxAllowed)
      await saveSettings()
      appendLog('RAM sauvegardée: ' + String(settings.ram) + ' MB')
  // sync slider value
  const slider = document.getElementById('ramSlider')
  if (slider) slider.value = String(settings.ram)
    })
  } catch (e) { appendLog('Erreur init RAM UI: ' + (e && e.message ? e.message : String(e))) }
}

// initialize RAM input after initial settings load
initRamInput()

// sync slider and presets
const ramSlider = document.getElementById('ramSlider')
if (ramSlider) {
  ramSlider.addEventListener('input', () => {
    const v = parseInt(ramSlider.value || '0', 10) || 4096
    const ramEl = document.getElementById('ram')
    if (ramEl) ramEl.value = String(v)
  })
}
const presetBtns = Array.from(document.querySelectorAll('.ramPreset'))
for (const btn of presetBtns) {
  btn.addEventListener('click', async (e) => {
    const v = parseInt(btn.getAttribute('data-val') || '4096', 10)
    const ramEl = document.getElementById('ram')
    const slider = document.getElementById('ramSlider')
    if (ramEl) ramEl.value = String(v)
    if (slider) slider.value = String(v)
    settings = settings || await loadSettings()
    settings.ram = v
    await saveSettings()
    appendLog('RAM preset sélectionné: ' + String(v) + ' MB')
  })
}

// Ensure Java 22 if no javaPath known
async function ensureJavaIfNeeded() {
  if (settings && settings.javaPath) return
  appendLog('Recherche Java...')
  const res = await window.electronAPI.ensureJava22(cachedJarUrl, jarURL)
  if (res && res.path) {
    settings = settings || {}
    settings.javaPath = res.path
    await saveSettings()
    appendLog('Java 22 trouvé/installe: ' + res.path)
  } else {
    appendLog('Java 22 non trouvé: ' + (res && res.error ? res.error : ''))
  }
}

// UI events

// ... UI file/dir chooser removed for simplified launcher

// DOM progress elements (guard if missing)
const globalBar = document.getElementById('globalBar')
const fileBar = document.getElementById('fileBar')
const globalPercent = document.getElementById('globalPercent')
const filePercent = document.getElementById('filePercent')
const fileNameEl = document.getElementById('fileName')

appendLog('Renderer initialized')

// Expert UI elements (inserted)
const expertToggle = document.getElementById('expertToggle')
const expertOptions = document.getElementById('expertOptions')
const extraJvmEl = document.getElementById('extraJvm')
const copyArgsBtn = document.getElementById('copyArgs')
const launchPidEl = document.getElementById('launchPid')
const killBtn = document.getElementById('killBtn')
if (expertToggle) expertToggle.addEventListener('change', () => { if (expertOptions) expertOptions.style.display = expertToggle.checked ? 'block' : 'none' })
if (copyArgsBtn) copyArgsBtn.addEventListener('click', async () => { try { const text = extraJvmEl ? extraJvmEl.value : '' ; await navigator.clipboard.writeText(text || '') ; appendLog('Options copiées dans le presse-papiers') } catch (e) { appendLog('Impossible de copier: ' + e.message) } })
if (killBtn) killBtn.addEventListener('click', async () => { try { const res = await window.electronAPI.launcherKill(); appendLog('Kill demandé: ' + JSON.stringify(res)); if (res && res.success) launchPidEl.textContent = '-'; } catch (e) { appendLog('Erreur kill: ' + e.message) } })

window.electronAPI.onSyncProgress((data) => {
  try {
    if (!data) return
    // prefer using the meta-provided totalFilesExpected if present
    const totalFiles = (typeof totalFilesExpected === 'number' && totalFilesExpected > 0) ? totalFilesExpected : (data.totalFiles || 0)

    // Only handle per-file states: 'downloading' and 'downloaded'/'ok' - no per-chunk progress
    appendLog('[sync] ' + (data.name || '') + ' -> ' + data.status + (data.reason ? (' (' + data.reason + ')') : ''))
    if (data.status === 'downloading') {
      if (fileNameEl) fileNameEl.textContent = data.name || ''
      if (fileBar) fileBar.style.width = '0%'
      if (filePercent) filePercent.textContent = '0%'
    }
    if (data.status === 'downloaded' || data.status === 'ok') {
      // mark file as 100%
      if (fileBar) fileBar.style.width = '100%'
      if (filePercent) filePercent.textContent = '100%'
      // increment completed files and update global bar
      filesCompleted = (filesCompleted || 0) + 1
      const total = totalFiles || 0
      const completePct = total > 0 ? Math.round((filesCompleted / total) * 100) : 0
      if (globalBar) globalBar.style.width = completePct + '%'
      if (globalPercent) globalPercent.textContent = completePct + '%'
    }
  } catch (err) {
    appendLog('Error in onSyncProgress handler: ' + (err && err.stack ? err.stack : String(err)))
  }
})
window.electronAPI.onSyncLog((msg) => {
  try {
    if (msg && typeof msg === 'object') {
      // prefer { text, level } shape
      const text = msg.text || msg.message || JSON.stringify(msg)
      const level = msg.level || 'info'
      appendLog('[sync][' + level + '] ' + String(text))
    } else {
      appendLog('[sync] ' + String(msg))
    }
  } catch (e) {
    appendLog('[sync] ' + String(msg))
  }
})

async function startSync(mcPath) {
  if (!cachedListUrl) { appendLog('Aucun sync URL détecté. Vérifie remote_info.json.'); return { success: false, error: 'no-list' } }
  if (!mcPath) { appendLog('mcPath non fourni'); return { success: false, error: 'no-mcpath' } }
  appendLog('Démarrage sync: ' + cachedListUrl)
  const res = await window.electronAPI.startSync({ listUrl: cachedListUrl, baseUrl: (cachedBaseUrl || cachedListUrl), mcPath, allowedDirs: allowedDirsList })
  appendLog('Sync terminé: ' + JSON.stringify(res))
  return res
}

// sync button removed. Single launch button will perform sync then launch

// receive totalFiles meta and initialize global variables
let totalFilesExpected = 0
let filesCompleted = 0
window.electronAPI.onSyncMeta((meta) => {
  totalFilesExpected = meta.totalFiles || 0
  filesCompleted = 0
  if (globalBar) globalBar.style.width = '0%'
  if (globalPercent) globalPercent.textContent = '0%'
})

// Try loading remote_info.json from known locations (hard-coded)
async function loadRemoteInfoAuto() {
  const candidates = [
    'https://galade.fr/Infuseting/stalkerRP/remote_info.json'
  ]
  for (const url of candidates) {
    try {
      appendLog('Tentative de chargement de remote_info: ' + url)
      const res = await window.electronAPI.fetchRemoteInfo(url)
      if (!res.success) { appendLog('Erreur: ' + res.error); continue }
      const info = res.json
      appendLog('Remote info chargé: ' + (info.install && info.install.name ? info.install.name : 'n/a'))
  cachedRemote = info
      if (info.install) {
        if (info.install.jarURL) {
          jarURL = info.install.jarURL
        }
        if (info.install.syncUrl) {
          try {
            cachedListUrl = new URL(info.install.syncUrl, url).toString()
          } catch (e) {
            cachedListUrl = info.install.syncUrl
          }
          try {
            cachedBaseUrl = new URL(cachedListUrl).toString()
          } catch (e) {
            cachedBaseUrl = cachedListUrl
          }
          appendLog('Sync URL: ' + cachedListUrl)
          appendLog('Base URL: ' + cachedBaseUrl)
          
        }
        if (info.install.name) {
          settings.folderName = "." + info.install.name;
          await saveSettings();
        }
        if (info.install.syncDir) {
          allowedDirsList = String(info.install.syncDir).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
          appendLog('Allowed sync dirs: ' + JSON.stringify(allowedDirsList))
        }
        if (info.install.JVMarg) {
          const match = String(info.install.JVMarg).match(/-Xmx(\d+)([gGmM])/) 
          if (match) {
            let val = parseInt(match[1],10)
            const unit = match[2].toLowerCase()
            if (unit === 'g') val = val * 1024
            document.getElementById('ram').value = val
          }
        }
        if (info.install.welcome) appendLog(info.install.welcome)
        if (info.install.jarURL) cachedJarUrl = info.install.jarURL
      }
      return
    } catch (e) {
      appendLog('Erreur lecture remote_info (' + url + '): ' + e.message)
    }
  }
  appendLog('Impossible de charger remote_info.json depuis les adresses connues.')
}

// Auto load on startup
loadRemoteInfoAuto()

// Autofill username input from settings when available


// Username live validation

// Launch handler

document.getElementById('launch').addEventListener('click', async () => {
  try {
  settings = settings || await loadSettings()
    await ensureJavaIfNeeded()
    // Use Node's path.join if available (require via preload), fallback to a simple join
    const path = (typeof require === 'function') ? require('path') : null;
    const mcPath = path
      ? path.join(settings.minecraftPath || '', settings.folderName || '')
      : ((settings.minecraftPath || '').replace(/[\/\\]+$/, '') + (settings.folderName ? '/' + settings.folderName : ''));
    const javaPath = settings.javaPath || 'java'
    const ram = settings.ram || 2048
    console.log(settings.minecraftPath);
    console.log(mcPath);

    if (!mcPath) { appendLog('Aucun dossier Minecraft configuré (settings.minecraftPath)'); return }


  await saveSettings()

  // Run sync first (if configured)
    if (cachedListUrl) {
      appendLog('Lancement du téléchargement avant exécution...')
      // reset counters
      totalFilesExpected = 0
      filesCompleted = 0
      if (globalBar) globalBar.style.width = '0%'
      if (globalPercent) globalPercent.textContent = '0%'
      await startSync(mcPath)
    } else {
      appendLog('Aucun sync configuré — lancement direct')
    }
    let forgeInstallerPath = null

    // Ensure Minecraft version + Forge are installed according to remote_info.json
    try { 
      const installRes = await window.electronAPI.installMcAndForge({ mcVersion: (cachedRemote && cachedRemote.install && cachedRemote.install.minecraft) || null, forgeVersion: (cachedRemote && cachedRemote.install && cachedRemote.install.forge) || null, mcPath, javaPath })
      appendLog('Install result: ' + JSON.stringify(installRes))
      if (!installRes || !installRes.success) {
        appendLog('Attention: installation MC/Forge a échoué ou incomplète — vérifie les logs ci-dessus')
      }
      else {
        forgeInstallerPath = installRes.forgeInstallerPath || null
      }
    } catch (e) {
      appendLog('Erreur durant installation MC/Forge: ' + (e && e.message ? e.message : String(e)))
    }

  const extraJvm = extraJvmEl ? (extraJvmEl.value || '') : ''
  const extraArgsArr = extraJvm ? extraJvm.split(' ').filter(Boolean) : []
  // send memoryMB explicitly (use settings.ram or numeric input; default to 4096 MB)
  const ramValue = settings && settings.ram ? Number(settings.ram) : (parseInt(document.getElementById('ram')?.value || '4096', 10) || 4096)
  const res = await window.electronAPI.launchVersion({ mcPath, forgePath : forgeInstallerPath, versionId: (cachedRemote && cachedRemote.install && cachedRemote.install.minecraft), javaPath, memoryMB: ramValue, extraJvmArgs: extraArgsArr })
  appendLog('Résultat lancement: ' + JSON.stringify(res))
  if (res && res.pid) launchPidEl.textContent = String(res.pid)
  } catch (e) {
    appendLog('Erreur lors du lancement: ' + (e && e.message ? e.message : String(e)))
  }
})
