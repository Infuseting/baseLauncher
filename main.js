const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const os = require('os')
const { pipeline } = require('stream')
const { promisify } = require('util')

const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth, tokenUtils, Minecraft } = require( "msmc");
const streamPipeline = promisify(pipeline)
const { spawn } = require('child_process')

// track whether a launch is already in progress to prevent concurrent launches
let launchInProgress = false
let currentLaunchPid = null

// If a remote install descriptor is loaded, prefer its name for default mc folder
let remoteInstallName = null


const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch (e) {}
  const defaultFolderName = remoteInstallName ? ('.' + String(remoteInstallName)) : '.CustomLauncher'
  const defaultMc = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  const defaults = { minecraftPath: defaultMc, folderName: defaultFolderName, javaPath: null, ram: 4096, lastModified: {}, token: "" }
  fs.mkdirSync(path.join(defaults.minecraftPath, defaults.folderName), { recursive: true })
  return defaults
}

function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8') } catch (e) {}
}

// Secure token management
function getAuthToken() {
  const settings = loadSettings()
  return settings.token || ""
}

function setAuthToken(token) {
  const settings = loadSettings()
  settings.token = token
  saveSettings(settings)
}
function createWindow () {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    icon: path.join(__dirname, 'icon', 'icon.png'), 
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile(path.join(__dirname, 'src', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

// IPC handlers
ipcMain.handle('dialog:openDirectory', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (res.canceled) return null
  return res.filePaths[0]
})

// Expose total system memory (in MB) for the renderer to bound RAM selection
ipcMain.handle('system:getMemory', async () => {
  try {
    const totalBytes = os.totalmem()
    const totalMB = Math.floor(totalBytes / (1024 * 1024))
    return { success: true, totalMB }
  } catch (e) { return { success: false, error: e && e.message } }
})

ipcMain.handle('dialog:openFile', async (_, filters) => {
  const res = await dialog.showOpenDialog({ properties: ['openFile'], filters })
  if (res.canceled) return null
  return res.filePaths[0]
})

ipcMain.handle('fs:exists', async (_, p) => {
  return fs.existsSync(p)
})

ipcMain.handle('fs:readdir', async (_, p) => {
  try {
    const entries = await fs.promises.readdir(p)
    return entries
  } catch (e) {
    return []
  }
})

// Settings IPC handlers (get/save)
ipcMain.handle('settings:get', async () => {
  return loadSettings()
})

ipcMain.handle('settings:set', async (_, s) => {
  try {
    saveSettings(s)
    return { success: true }
  } catch (e) {
    return { success: false, error: e && e.message }
  }
})

// Launch Minecraft via java
ipcMain.handle('launch:java', async (_, { javaPath, args }) => {
  const { spawn } = require('child_process')
  return new Promise((resolve) => {
    try {
      const safeArgs = Array.isArray(args) ? args.slice() : []
      // On Windows the CreateProcess command line limit can be hit. If our assembled command is large,
      // write an argument file and launch with @argfile (Java supports @argfile semantics).
      const isWindows = process.platform === 'win32'
      const combinedLength = (javaPath || 'java') + ' ' + safeArgs.join(' ')
      let launchArgs = safeArgs
      let argfilePath = null
      const MAX_CMD = isWindows ? 30000 : 100000
      const escapeArgForFile = (a) => {
        if (typeof a !== 'string') a = String(a)
        // If contains whitespace or special chars, wrap in double-quotes and escape inner quotes
        if (/\s/.test(a) || /"/.test(a)) {
          return '"' + a.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
        }
        return a
      }

      if (isWindows && combinedLength.length > MAX_CMD) {
        try {
          argfilePath = path.join(os.tmpdir(), 'stalkerrp-args-' + crypto.randomBytes(8).toString('hex') + '.txt')
          const content = safeArgs.map(escapeArgForFile).join(os.EOL)
          fs.writeFileSync(argfilePath, content, 'utf8')
          launchArgs = ['@' + argfilePath]
        } catch (e) {
          // fallback to original args if writing fails
          launchArgs = safeArgs
        }
      }

      const child = spawn(javaPath || 'java', launchArgs, { detached: true, stdio: 'ignore' })
      child.on('error', (err) => resolve({ success: false, error: err.message }))
      // best-effort: don't wait for exit; assume started if no immediate error
      child.unref()
      // do not delete argfile immediately; leave it to OS/temp cleanup
      resolve({ success: true, pid: child.pid, cmd: javaPath || 'java', args: launchArgs })
    } catch (err) {
      resolve({ success: false, error: err && err.message })
    }
  })
})

// Launch a specific Minecraft version (builds classpath, extracts natives, spawns java)

ipcMain.handle('launcher:runVersion', async (event, { mcPath, forgePath, javaPath, versionId, memoryMB }) => {
  const authManager = new Auth("select_account");
  let token = getAuthToken();
  console.log(token)
  // Vérifie la validité du token
  let valid = false;
  if (token) {
    try {
      console.log("test");
      let mc = tokenUtils.fromMclcToken(authManager,token);
      console.log(mc);
      mc = await mc.refresh(); 
      console.log(mc)
      valid = mc instanceof (Minecraft)
    } catch (e) { console.log(e); valid = false; }
  }

  if (!valid) {
    // Demande le relog à l'utilisateur (popup Electron)
    // MSMC: lance le flow d'authentification
    try {
      const result = await authManager.launch("raw");
      if (result && await result.getMinecraft()) {
        let mc = await result.getMinecraft();
        let token = mc.mclc(true);
        setAuthToken(token);
        event.sender.send('sync:log', { level: 'info', text: 'Authentification reussis'});
      } else {
        event.sender.send('sync:log', { level: 'error', text: 'Authentification échouée.' });
        return { success: false, error: 'auth-failed' };
      }
    } catch (e) {
      event.sender.send('sync:log', { level: 'error', text: 'Erreur auth: ' + (e && e.message ? e.message : String(e)) });
      return { success: false, error: 'auth-exception' };
    }
  }

  // Lance Minecraft avec le token valide
  launchMc(event, mcPath, forgePath, javaPath, versionId, memoryMB, token);
  return { success: true };
})

function launchMc( _, mcPath, forgePath, javaPath, versionId, memoryMB, token) {    
    const launcher = new Client();
    let opts = {
      authorization: token, 
      root: mcPath,
      version: {
          number: versionId,
          //number: "1.12.2",
          type: "release"
      },
      forge: forgePath,
      javaPath: javaPath,
    memory: {
      max: (memoryMB && Number.isFinite(Number(memoryMB))) ? String(Math.max(512, Math.floor(Number(memoryMB))) + 'M') : '4G',
      min: "1G"
    }
  }
    launcher.launch(opts);

    launcher.on('debug', (e) =>  { try { _.sender.send('sync:log', { level: 'debug', text: String(e) }) } catch(f){} });
    launcher.on('error', (e) =>  { try { _.sender.send('sync:log', { level: 'error', text: String(e) }) } catch(f){} });
    launcher.on('info', (e) => { try { _.sender.send('sync:log', { level: 'info', text: String(e) }) } catch(f){} });
    launcher.on('warn', (e) =>  { try { _.sender.send('sync:log', { level: 'warn', text: String(e) }) } catch(f){} });
    launcher.on('data', (e) =>  { try { _.sender.send('sync:log', { level: 'data', text: String(e) }) } catch(f){} });
}
// Kill the currently launched process (best-effort)
ipcMain.handle('launcher:kill', async () => {
  try {
    if (!currentLaunchPid) return { success: false, error: 'no-process' }
    try {
      process.kill(currentLaunchPid)
    } catch (e) {
      try { require('child_process').execSync('taskkill /PID ' + currentLaunchPid + ' /F') } catch (e2) {}
    }
    return { success: true, pid: currentLaunchPid }
  } catch (e) {
    return { success: false, error: e && e.message }
  }
})

// Download a remote URL to destination path (creates directories)
ipcMain.handle('download:remoteList', async (_, { url, gameDir }) => {
  const fetchJson = (u) => new Promise((resolve, reject) => {
    const client = u.startsWith('https') ? https : http
    client.get(u, (res) => {
      if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode))
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })

  const downloadTo = (u, dest) => new Promise((resolve, reject) => {
    const dir = path.dirname(dest)
    fs.mkdirSync(dir, { recursive: true })
    const file = fs.createWriteStream(dest)
    const client = u.startsWith('https') ? https : http
    client.get(u, (res) => {
      if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode))
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    }).on('error', (err) => { fs.unlinkSync(dest, { force: true }); reject(err) })
  })

  try {
    const json = await fetchJson(url)
    const files = json.files || []
    for (const f of files) {
      const rel = f.path || f.destination || f.dest || f.name
      if (!rel) continue
      const dest = path.join(gameDir, rel)
      await downloadTo(f.url, dest)
    }
    return { success: true, count: files.length }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Detect java version given a path or using 'java'
ipcMain.handle('java:detect', async (_, javaPath) => {
  const { spawn } = require('child_process')
        return new Promise((resolve, reject) => {
    try {
            const p = spawn(javaPath || 'java', ['-version'])
      let out = ''
      p.stderr.on('data', (d) => out += d.toString())
      p.stdout.on('data', (d) => out += d.toString())
            p.on('error', (err) => reject({ success: false, error: err.message }))
            p.on('close', (code) => {
              if (code === 0 || out) resolve({ success: true, output: out.trim() })
              else reject({ success: false, error: 'Non-zero exit: ' + code })
      })
    } catch (err) {
            reject({ success: false, error: err.message })
    }
  })
})

async function computeFileMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const rs = fs.createReadStream(filePath)
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}

ipcMain.handle('sync:start', async (event, { listUrl, baseUrl, mcPath, allowedDirs }) => {
  try {
    if (!listUrl) throw new Error('listUrl required')
    if (!baseUrl) baseUrl = listUrl
    fs.mkdirSync(mcPath, { recursive: true })

  appendLog = (msg) => { try { event.sender.send('sync:log', { level: 'info', text: String(msg) }) } catch(e){} }

    appendLog('Fetching list: ' + listUrl)
    const res = await fetch(listUrl)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const list = await res.json()

  const files = Array.isArray(list) ? list : (list.files || [])
  const summary = { downloaded: 0, skipped: 0, removed: 0, errors: [] }

    // Separate directories and regular files. We'll create directories first
    // normalize allowedDirs if provided
    // allowedDirs can be an array of relative paths (files or folders). We'll build
    // exact-file set and directory-prefix set for matching.
    let allowedExact = new Set()
    let allowedPrefixes = []
    let allowedProvided = false
    if (Array.isArray(allowedDirs) && allowedDirs.length) {
      allowedProvided = true
      for (const d of allowedDirs) {
        if (!d) continue
        let norm = String(d).trim().replace(/\\/g, '/').replace(/^\//, '').replace(/\s+/g, '')
        if (!norm) continue
        // directory entry: ensure trailing slash
        if (norm.endsWith('/')) {
          const p = norm.replace(/\\/g, '/').toLowerCase()
          allowedPrefixes.push(p)
        } else {
          // could be file or directory without trailing slash; treat as both exact and prefix
          const low = norm.toLowerCase()
          allowedExact.add(low)
          allowedPrefixes.push(low + '/')
        }
      }
    }

  const dirsAll = files.filter(f => f.name && f.name.endsWith('/'))
  const filesAll = files.filter(f => f.name && !f.name.endsWith('/'))
  // Always create directories for all server directories
  const dirs = dirsAll
  // Download all files present on server: for top-levels in allowedSet they will be mirrored,
  // for others they will be downloaded if missing but not deleted during cleanup.
  const filesToDownload = filesAll
    const totalFiles = filesToDownload.length

    // Inform renderer how many files will be downloaded
    try { event.sender.send('sync:meta', { totalFiles }) } catch (e) {}

    // Create directories
    for (const d of dirs) {
      const destDir = path.join(mcPath, d.name)
      await fs.promises.mkdir(destDir, { recursive: true })
      event.sender.send('sync:progress', { name: d.name, status: 'dir-created' })
      summary.skipped++
    }

  // track files that are verified OK (either skipped because up-to-date, preserved local, or freshly downloaded+validated)
  const verified = new Set()

  // build an inferred set of top-level names present on the server so we can decide mirroring behavior
  const inferredTop = new Set()
  for (const f of files) {
    if (!f.name) continue
    const n = f.name.replace(/^\//, '').replace(/\\/g, '/')
    const t = n.split('/')[0]
    if (t) inferredTop.add(t.toLowerCase())
  }

  const isPathAllowed = (normPath) => {
    // normPath should be lowercased, no leading slash
    if (!normPath) return false
    const p = normPath.toLowerCase()
    if (allowedExact.has(p)) return true
    for (const pref of allowedPrefixes) if (p.startsWith(pref)) return true
    return false
  }

  const isTopAllowed = (top) => {
    if (allowedProvided) {
      // consider top allowed if any allowed prefix/exact lies under this top
      if (!top) return false
      const t = top.toLowerCase()
      for (const pref of allowedPrefixes) if (pref.startsWith(t + '/')) return true
      for (const ex of Array.from(allowedExact)) if (ex.split('/')[0] === t) return true
      return false
    }
    return inferredTop.has(top)
  }

  for (let idx = 0; idx < filesToDownload.length; idx++) {
      const entry = filesToDownload[idx]
      const name = entry.name
      const dest = path.join(mcPath, name)
      const normName = name.replace(/^\//, '').replace(/\\/g, '/')
      const normNameKey = normName.toLowerCase()
      const top = (normName.split('/')[0] || '').toLowerCase()

      await fs.promises.mkdir(path.dirname(dest), { recursive: true })

      let needDownload = true
      if (fs.existsSync(dest)) {
        try {
          const md5 = await computeFileMd5(dest)
          const stat = await fs.promises.stat(dest)
          if (md5 === entry.md5 && String(stat.size) === String(entry.size)) {
            needDownload = false
          } else {
            // If the file exists but differs, only overwrite if the file path is within an allowed path
            // (allowedDirs). Otherwise preserve local modifications.
            if (!isPathAllowed(normNameKey)) {
              // preserve local modified file outside allowedDirs: do not overwrite
              event.sender.send('sync:progress', { name, status: 'ok', reason: 'preserve-local', index: idx + 1, totalFiles })
              // mark as verified so cleanup won't remove it
              try { verified.add(normNameKey) } catch (e) {}
              summary.skipped++
              continue
            }
            // otherwise allow download/overwrite
          }
        } catch (e) {
          // treat as needing download
        }
      }

      if (!needDownload) {
  event.sender.send('sync:progress', { name, status: 'ok', index: idx + 1, totalFiles })
  // mark as verified (present and matching)
  try { verified.add(normNameKey) } catch (e) {}
  summary.skipped++
        continue
      }

      // Build file URL
      let fileUrl
      try {
        fileUrl = new URL(name, baseUrl).toString()
      } catch (e) {
        // fallback to simple concat
        fileUrl = baseUrl.replace(/\/$/, '') + '/' + name.replace(/^\//, '')
      }

      event.sender.send('sync:progress', { name, status: 'downloading', url: fileUrl, index: idx + 1, totalFiles })

      // Stream download to file with progress reports
      try {
        await new Promise((resolve, reject) => {
          const client = fileUrl.startsWith('https') ? https : http
          const req = client.get(fileUrl, (res) => {
            if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode))
              fs.mkdirSync(path.dirname(dest), { recursive: true })
              const fileStream = fs.createWriteStream(dest)
              // Stream the response directly to disk; do NOT emit per-chunk progress events (they slow downloads)
              res.pipe(fileStream)
              fileStream.on('finish', () => fileStream.close(resolve))
            res.on('error', (err) => { try { fs.unlinkSync(dest, { force: true }) } catch (e) {} ; reject(err) })
            fileStream.on('error', (err) => { try { fs.unlinkSync(dest, { force: true }) } catch (e) {} ; reject(err) })
          })
          req.on('error', reject)
        })
      } catch (err) {
        const reason = err && err.message ? err.message : String(err)
        event.sender.send('sync:progress', { name, status: 'error', reason, index: idx + 1, totalFiles })
        summary.errors.push({ name, reason })
        continue
      }

      const buffer = await fs.promises.readFile(dest)
      const md5 = crypto.createHash('md5').update(buffer).digest('hex')
      const size = buffer.length
      if (md5 !== entry.md5 || String(size) !== String(entry.size)) {
        const reason = 'md5/size mismatch'
        event.sender.send('sync:progress', { name, status: 'error', reason, index: idx + 1, totalFiles })
        summary.errors.push({ name, reason })
        continue
      }

  event.sender.send('sync:progress', { name, status: 'downloaded', index: idx + 1, totalFiles })
  // mark as verified
  try { verified.add(name.replace(/^\//, '').replace(/\\/g, '/')) } catch (e) {}
  summary.downloaded++
    }

      // Mirror cleanup: remove any local files/dirs under the server top-level folders
      try {
    // Build expected sets: files (no trailing slash) and directories (with trailing slash).
        // Also include parent directories for each file so we don't delete directories that should contain expected files.
        const expectedFiles = new Set()
        const expectedDirs = new Set()
        for (const f of files) {
          if (!f.name) continue
          // normalize: remove leading slash and backslashes
          const n = f.name.replace(/^\//, '').replace(/\\/g, '/')
          const norm = n.toLowerCase()
          if (n.endsWith('/')) {
              expectedDirs.add(norm.replace(/\/+$/, '/') )
            } else {
              expectedFiles.add(norm)
            // add parent dirs
            const parts = n.split('/')
            for (let i = 1; i <= parts.length - 1; i++) {
              const dir = parts.slice(0, i).join('/') + '/'
              expectedDirs.add(dir.toLowerCase())
            }
          }
        }

      // determine top-level folders referenced by the server list or use allowedProvided to restrict
      const topDirs = new Set()
      if (allowedProvided) {
        // use the first segment of allowed prefixes/exacts
        for (const pref of allowedPrefixes) {
          const seg = pref.replace(/\/$/, '').split('/')[0]
          if (seg) topDirs.add(seg.toLowerCase())
        }
        for (const ex of Array.from(allowedExact)) {
          const seg = ex.split('/')[0]
          if (seg) topDirs.add(seg.toLowerCase())
        }
      } else {
        for (const p of expectedFiles) {
          const parts = p.split('/')
          if (parts.length > 0 && parts[0]) topDirs.add(parts[0].toLowerCase())
        }
        for (const d of expectedDirs) {
          const parts = d.replace(/\/$/, '').split('/')
          if (parts.length > 0 && parts[0]) topDirs.add(parts[0].toLowerCase())
        }
      }

        // helper to walk directory recursively and return relative paths
        const walkDir = async (dir) => {
          const out = []
          try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true })
            for (const e of entries) {
              const abs = path.join(dir, e.name)
              const rel = path.relative(mcPath, abs).replace(/\\\\/g, '/')
              if (e.isDirectory()) {
                out.push(rel + '/')
                const inner = await walkDir(abs)
                out.push(...inner)
              } else if (e.isFile()) {
                out.push(rel)
              }
            }
          } catch (e) {
            // ignore
          }
          return out
        }

        // Enable dry-run during debugging to avoid destructive deletions
        const DRY_RUN = false

        for (const td of Array.from(topDirs)) {
          const localTop = path.join(mcPath, td)
          if (!fs.existsSync(localTop)) continue
          const localEntries = await walkDir(localTop)
          for (const rel of localEntries) {
              // normalize relative key
              const key = rel.replace(/^\/?/, '').replace(/\\/g, '/').toLowerCase()
              const isDir = key.endsWith('/')
                // safety: only consider deletions for items whose top-level folder is in topDirs
                const top = key.replace(/^\//, '').split('/')[0]
                if (!topDirs.has(top)) {
                  // skip items outside the syncDir
                  continue
                }
                // Only consider deletion if the local entry falls under an allowed prefix or exact path
                let considerDeletion = false
                if (allowedProvided) {
                  // if this relative path matches any allowed prefix/exact -> allowed for mirroring and deletion
                  if (allowedExact.has(key) ) considerDeletion = true
                  else {
                    for (const pref of allowedPrefixes) { if (key.startsWith(pref)) { considerDeletion = true; break } }
                  }
                } else {
                  // no allowedDirs provided -> mirror everything under topDirs
                  considerDeletion = true
                }
                if (!considerDeletion) continue
              // emit diagnostic check info
              try { event.sender.send('sync:progress', { name: key, status: 'check', details: { isDir, inExpectedFile: expectedFiles.has(key), inExpectedDir: expectedDirs.has(key), inVerified: verified.has(key.replace(/\/$/, '')), top, topAllowed: topDirs.has(top) } }) } catch (e) {}
            // decide deletion: if file -> delete only if not in expectedFiles
            // if dir -> delete only if not in expectedDirs
            // also skip deletion if this path was verified during this run
            if (verified.has(key.replace(/\/$/, '')) ) {
              continue
            }
            if ((isDir && !expectedDirs.has(key)) || (!isDir && !expectedFiles.has(key))) {
              const abs = path.join(mcPath, key)
                try {
                  const st = await fs.promises.stat(abs)
                  if (DRY_RUN) {
                    try { event.sender.send('sync:progress', { name: key, status: 'would-delete', reason: 'dry-run extraneous' }) } catch (e) {}
                  } else {
                    if (st.isDirectory()) {
                      await fs.promises.rm(abs, { recursive: true, force: true })
                    } else {
                      
                      await fs.promises.rm(abs, { force: true })
                    }
                    summary.removed++
                    try { event.sender.send('sync:progress', { name: key, status: 'deleted', reason: 'extraneous' }) } catch (e) {}
                  }
                } catch (e) {
                  // can't remove, report error
                  summary.errors.push({ name: key, reason: String(e && e.message) })
                  try { event.sender.send('sync:progress', { name: key, status: 'error', reason: String(e && e.message) }) } catch (e) {}
                }
            }
          }
        }
      } catch (e) {
        // non-fatal: record error
        summary.errors.push({ name: 'mirror-cleanup', reason: String(e && e.message) })
      }

      return { success: true, summary }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('remote:fetch', async (_, url) => {
  try {
    if (!url) throw new Error('URL required')
  appendLog = (msg) => { /* no-op if no event */ }
    const res = await fetch(url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = await res.json()
    if (json && json.install && json.jarURL) {
      jarURL = json.install.jarURL;
    }
    return { success: true, json }
  } catch (err) {
    return { success: false, error: err.message }
  }
})


// Install vanilla MC version and Forge installer/installer-run
ipcMain.handle('install:mc-and-forge', async (event, { mcVersion, forgeVersion, mcPath, javaPath }) => {
  appendLog = (msg) => { try { event.sender.send('sync:log', { level: 'info', text: String(msg) }) } catch(e){} }
  try {
    if (!mcVersion) throw new Error('mcVersion required')
    if (!mcPath) throw new Error('mcPath required')
    appendLog('Install: requested MC ' + mcVersion + ' and Forge ' + forgeVersion)
  let forgeDetectedVersion = null


    // If forgeVersion provided, try to download the Forge installer
    let forgeInstallerPath = null
    if (forgeVersion) {
      // common URL patterns for Forge maven
      const candidates = [
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`,
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-universal.jar`,
        // older pattern
        `https://files.minecraftforge.net/maven/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`
      ]

      const tmpDir = path.join(app.getPath('userData'), 'forge_tmp')
      fs.mkdirSync(tmpDir, { recursive: true })

      const installerFilename = `forge-${mcVersion}-${forgeVersion}-installer.jar`
      const universalFilename = `forge-${mcVersion}-${forgeVersion}-universal.jar`
      const installerPath = path.join(tmpDir, installerFilename)
      const universalPath = path.join(tmpDir, universalFilename)

      if (fs.existsSync(installerPath)) {
        forgeInstallerPath = installerPath
      } else if (fs.existsSync(universalPath)) {
        forgeInstallerPath = universalPath
      } else {
        // Try to download the installer (write to a file, not to the directory)
        for (const url of candidates) {
          try {
            await fs.promises.mkdir(tmpDir, { recursive: true })
            // derive filename from URL path; fallback to installerFilename
            let filename = installerFilename
            try { filename = path.basename(new URL(url).pathname) || installerFilename } catch (e) { filename = installerFilename }
            const dest = path.join(tmpDir, filename)
            await downloadFile(url, dest)
            if (fs.existsSync(dest)) {
              appendLog('Forge installer downloaded: ' + url)
              forgeInstallerPath = dest
              break
            }
          } catch (e) {
            appendLog('Error downloading Forge installer: ' + e.message)
          }
        }
      }
    }
    return { success: true, forgeInstallerPath}
  } catch (e) {
    return { success: false, error: e && e.message }
  }
})
const downloadFile = async (url, dest) => {
      let current = url
      const maxRedirects = 8
      for (let i = 0; i < maxRedirects; i++) {
        const res = await new Promise((resolve, reject) => {
          const client = current.startsWith('https') ? https : http
          const req = client.get(current, (r) => resolve(r)).on('error', reject)
          req.setTimeout(30000, () => req.abort())
        })

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          current = new URL(res.headers.location, current).toString()
          continue
        }
        if (res.statusCode >= 400) throw new Error('HTTP ' + res.statusCode)

        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(dest)
          res.pipe(file)
          file.on('finish', () => { file.close(); resolve() })
          file.on('error', (err) => { try { fs.unlinkSync(dest, { force: true }) } catch (e){}; reject(err) })
        })
        return
      }
      throw new Error('Too many redirects')
    }
// Java detection and ensure
ipcMain.handle('java:ensure22', async (_, preferredPath, jarURL) => {
  // Try detect local java installations: prefer provided preferredPath then 'java' cmd
  const candidates = []
  if (preferredPath) candidates.push(preferredPath)
  candidates.push('java')

  const detect = async (p) => {
    try {
      const { spawn } = require('child_process')
      return new Promise((resolve) => {
        const pr = spawn(p, ['-version'])
        let out = ''
        pr.stderr.on('data', (d) => out += d.toString())
        pr.stdout.on('data', (d) => out += d.toString())
        pr.on('error', () => resolve(null))
        pr.on('close', () => resolve(out))
      })
    } catch (e) { return null }
  }

  for (const c of candidates) {
    const out = await detect(c)
    if (!out) continue
    if (/version \"(\d+)(?:\.|_)/.test(out)) {
      const v = parseInt(RegExp.$1, 10)
      if (v >= 22) return { path: c, version: v }
    }
  }

    try {
    // Candidate URLs: try the specific release asset first (user-provided), then the generic latest-download
    const candidates = [
      
    ]
    
    candidates.push(jarURL)
    console.log(candidates);
    
    const downloadDest = path.join(app.getPath('userData'), 'jdk22.zip')
    const outDir = path.join(app.getPath('userData'), 'jdk22')

    // If the launcher previously extracted a JDK into outDir, try to reuse it
    try {
      if (fs.existsSync(outDir)) {
        const findJavaIn = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const e of entries) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) {
              const r = findJavaIn(p)
              if (r) return r
            } else if (e.isFile() && e.name.toLowerCase() === 'java.exe') {
              return p
            }
          }
          return null
        }
        const existing = findJavaIn(outDir)
        if (existing) {
          // verify version quickly
          try {
            const { spawnSync } = require('child_process')
            const proc = spawnSync(existing, ['-version'], { encoding: 'utf8', timeout: 5000 })
            const out = (proc.stdout || '') + (proc.stderr || '')
            const m = out && out.match(/version \"(\d+)(?:\.|_)/)
            if (m && parseInt(m[1], 10) >= 22) {
              return { path: existing, version: parseInt(m[1], 10), installed: true }
            }
            // otherwise continue to download flow
          } catch (e) {
            // ignore and proceed to download
          }
        }
      }
    } catch (e) {
      // non-fatal, proceed to download
    }

    // Helper: download following redirects
  

    // Helper: fetch GitHub releases JSON to find proper asset if direct links fail
    const fetchJson = (u) => new Promise((resolve, reject) => {
      const client = u.startsWith('https') ? https : http
      const options = { headers: { 'User-Agent': 'StalkerRP-Launcher' } }
      client.get(u, options, (res) => {
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode))
        let data = ''
        res.on('data', (c) => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
      }).on('error', reject)
    })

    // Try candidate URLs in order
    let downloaded = false
    let lastErr = null
    for (const candidate of candidates) {
      try {
        await downloadFile(candidate, downloadDest)
        downloaded = true
        break
      } catch (err) {
        lastErr = err
      }
    }

    if (!downloaded) {
      // If the last error indicates a 404, try GitHub API lookup for the latest release assets
      if (lastErr && String(lastErr).includes('HTTP 404')) {
        try {
          const apiUrl = 'https://api.github.com/repos/adoptium/temurin22-binaries/releases/latest'
          const release = await fetchJson(apiUrl)
          const assets = release.assets || []
          const match = assets.find(a => /jre.*windows.*x64.*zip/i.test(a.name) || /jre.*windows.*x64/i.test(a.name))
          if (match && match.browser_download_url) {
            await downloadFile(match.browser_download_url, downloadDest)
            downloaded = true
          } else {
            throw new Error('No suitable asset found in release')
          }
        } catch (e2) {
          throw new Error('Direct downloads failed and GitHub API lookup failed: ' + (e2 && e2.message))
        }
      } else {
        throw lastErr || new Error('Failed to download JDK')
      }
    }

    // quick sanity check: ensure zip magic bytes (PK..)
    try {
      const fd = fs.openSync(downloadDest, 'r')
      const hdr = Buffer.alloc(4)
      fs.readSync(fd, hdr, 0, 4, 0)
      fs.closeSync(fd)
      if (!(hdr[0] === 0x50 && hdr[1] === 0x4b)) {
        throw new Error('Downloaded file is not a ZIP archive (bad magic)')
      }
    } catch (e) {
      throw new Error('Downloaded archive invalid: ' + (e && e.message))
    }

    const AdmZip = require('adm-zip')
const { spawn } = require('child_process')
    const zip = new AdmZip(downloadDest)
    zip.extractAllTo(outDir, true)
    // attempt to find java.exe inside extracted folder
    const found = (function findJava(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          const r = findJava(p)
          if (r) return r
        } else if (e.isFile() && e.name.toLowerCase() === 'java.exe') {
          return p
        }
      }
      return null
    })(outDir)
    if (found) {
      return { path: found, version: 22, installed: true }
    }
  } catch (e) {
    return { error: e.message }
  }

  return { error: 'No suitable Java 22 found or installed' }
})

