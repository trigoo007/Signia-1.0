const { EventEmitter } = require('events');
const { exec, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger'); // Ajustar ruta: require('../utils/logger') si está en strategies/
const { performance } = require('perf_hooks');
const { app } = require('electron'); // Necesario para app.getPath

// Definición de la clase base (asegúrate de que esté definida o importada)
class SpeechRecognitionStrategy extends EventEmitter {
  constructor() { super(); this.isInitialized = false; this.isListening = false; }
  async initialize(options) { throw new Error('Method not implemented'); }
  async startListening(options) { throw new Error('Method not implemented'); }
  async stopListening() { throw new Error('Method not implemented'); }
  cleanup() { throw new Error('Method not implemented'); }
}


class MacOSSpeechStrategy extends SpeechRecognitionStrategy {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.recognitionProcess = null;
    this.currentTranscription = '';
    this.watchClipboardInterval = null;
    this.watchFileInterval = null;
    this.dictationCheckInterval = null;
    this.tempFilePath = '';
    this.tempFolderPath = null;
    this.dictationEnabled = false;
    this.retryCount = 0;
    this.maxRetries = options.maxRetries || 3;
    this.dictationCommands = { start: null, stop: null };
    this.dictationScripts = { start: null, stop: null, altStart: null, altStop: null };
    this.dictationInProgress = false;
    this.cancelRequested = false;
    this.isInitialized = false;
    this.isListening = false;
    this.intermediateTranscriptions = [];
    this.maxIntermediateTranscriptions = options.maxIntermediateTranscriptions || 5;
    this.inactivityTimer = null;
    this.maxInactivityTime = options.maxInactivityTime || 15000;
  }

  async initialize(options = {}) {
     if (this.isInitialized) return true;
     this.logger.info('Inicializando MacOSSpeechStrategy...');
     try {
        if (os.platform() !== 'darwin') throw new Error('MacOSSpeechStrategy solo funciona en macOS');
        this.maxRetries = options.maxRetries || this.maxRetries;
        this.maxInactivityTime = options.maxInactivityTime || this.maxInactivityTime;
        await this._checkSpeechRecognitionAvailability();
        await this._detectMacOSVersion();
        await this._createTempFolder();
        await this._createDictationScripts(); // Crear scripts .scpt
        this.logger.info('Estrategia macOS inicializada.');
        this.logger.warn('NOTA: Dependencia de AppleScript puede ser frágil.');
        this.logger.warn('LIMITACIÓN: Evite usar portapapeles manualmente durante dictado.');
        this.isInitialized = true;
        return true;
     } catch (error) {
        this.logger.error('Error inicializando MacOSSpeechStrategy:', error);
        this.isInitialized = false;
        this.emit('dictationError', this._createError('INITIALIZATION_FAILED', error.message, error));
        throw error;
     }
   }

  async _createTempFolder() {
    try {
      const sessionId = Date.now().toString();
      let baseDir;
      // Intentar obtener userData, usar tmpdir como fallback si falla
      try { baseDir = path.join(app.getPath('userData'), 'temp_scripts'); }
      catch (e) { this.logger.warn("app.getPath('userData') no disponible aún, usando os.tmpdir()"); baseDir = os.tmpdir(); }

      this.tempFolderPath = path.join(baseDir, `macos_dictation_${sessionId}`);
      await fs.ensureDir(this.tempFolderPath);
      this.logger.info(`Carpeta temporal creada en: ${this.tempFolderPath}`);
      this.tempFilePath = path.join(this.tempFolderPath, 'dictation_output.txt');
      return true;
    } catch (error) {
      this.logger.error('Error al crear carpeta temporal, usando os.tmpdir() como fallback final', error);
      this.tempFolderPath = os.tmpdir(); // Fallback final
      this.tempFilePath = path.join(this.tempFolderPath, `dictation_output_${Date.now()}.txt`);
      return false;
    }
  }

  // ***** INICIO DE LA CORRECCIÓN *****
  // Helper para ejecutar comandos 'defaults read' usando spawn (más seguro con argumentos)
  _runDefaultsRead(commandString) {
    return new Promise((resolve, reject) => {
      // Separar el comando en partes: 'defaults', 'read', 'domain', 'key'
      // Esta expresión regular intenta manejar claves con o sin comillas
      const parts = commandString.match(/^(.*?)\s+(["'](.+?)["']|(\S+))$/);
      if (!parts || parts.length < 4) { // Necesita al menos el comando completo, domain, y (key con o sin comillas)
        this.logger.error(`Formato de comando inválido para defaults: ${commandString}`);
        return reject(new Error(`Formato de comando inválido para defaults: ${commandString}`));
      }

      const domain = parts[1].trim();
      // La clave puede estar en parts[3] (si estaba entre comillas) o parts[4] (si no tenía espacios/comillas)
      const key = parts[3] || parts[4];

      if (!domain || !key) {
         return reject(new Error(`No se pudo parsear domain/key de: ${commandString}`));
      }

      const cmd = 'defaults';
      const args = ['read', domain, key];

      this.logger.debug(`Ejecutando (spawn): ${cmd} ${args.join(' ')}`);

      try {
        const defaultsProcess = spawn(cmd, args, { timeout: 3000 }); // Usar spawn
        let stdout = '';
        let stderr = '';

        defaultsProcess.stdout.on('data', (data) => stdout += data.toString());
        defaultsProcess.stderr.on('data', (data) => stderr += data.toString());

        defaultsProcess.on('close', (code) => {
          if (code === 0) {
             if (stderr.trim()) logger.warn(`defaults read ${domain} ${key} stderr: ${stderr.trim()}`);
             resolve(stdout.trim());
          } else {
             // Código 1 a menudo significa clave no encontrada, lo tratamos como error para Promise.all
             reject(new Error(`Comando defaults falló (code ${code}): ${stderr.trim() || stdout.trim() || 'Clave no encontrada'}`));
          }
        });

        defaultsProcess.on('error', (err) => {
           reject(new Error(`Error spawn ${cmd}: ${err.message}`));
        });

      } catch(spawnError) {
           reject(new Error(`Error al iniciar spawn para defaults: ${spawnError.message}`));
      }
    });
  }
  // ***** FIN DE LA CORRECCIÓN *****


  async _checkSpeechRecognitionAvailability() {
    this.logger.debug("Verificando disponibilidad del dictado de macOS...");
    const keysToCheck = [
        'com.apple.speech.recognition.AppleSpeechRecognition.prefs DictationIMEnabled',
        // 'com.apple.assistant "Assistant Enabled"', // Esta clave puede ser menos fiable
        'com.apple.speech.recognition.AppleSpeechRecognition.prefs DictationIMMasterDictationEnabled'
    ];
    let enabled = false;
    for (const key of keysToCheck) {
        try {
            const stdout = await this._runDefaultsRead(key); // Usar la versión corregida con spawn
            if (stdout && parseInt(stdout.trim()) === 1) {
                this.logger.info(`Preferencia encontrada activa: ${key}`); enabled = true; break;
            }
        } catch (error) {
            // Es normal que algunas claves no existan, loguear solo si es inesperado
            if (!error.message.toLowerCase().includes('does not exist')) {
                this.logger.warn(`Error leyendo preferencia ${key}: ${error.message}`);
            } else {
                 logger.debug(`Preferencia ${key} no encontrada.`);
            }
        }
    }
    if (!enabled) {
        const errorMsg = 'Dictado macOS no habilitado. Active en Preferencias del Sistema.';
        this.emit('dictationNeedsUserSetup', errorMsg); throw new Error(errorMsg);
    }
    const isRunning = await this._isDictationServiceRunning();
    logger.debug(`Servicio de dictado ${isRunning ? 'está' : 'NO está'} corriendo.`);
    this.dictationEnabled = true; return true;
 }


  async _isDictationServiceRunning() {
    return new Promise((resolve) => {
      const processesToCheck = ['com.apple.SpeechRecognitionCore.speechrecognitiond', 'SpeechRecognitionServer', 'DictationIM', 'SpeechRecognizerServer', 'SpeechRecognizer'];
      const command = `pgrep -if "${processesToCheck.join('|')}"`; // -i para ignorar mayúsculas
      exec(command, { timeout: 1000 }, (error, stdout) => { resolve(!error && !!stdout.trim()); });
    });
  }

  _activateDictationService() {
    this.logger.warn("Activación programática no implementada."); return Promise.resolve(true);
  }

  async _detectMacOSVersion() {
    return new Promise((resolve, reject) => {
        exec('sw_vers -productVersion', { timeout: 1000 }, (error, stdout) => {
             if (error) {
                 this.logger.warn("No se pudo detectar versión macOS, usando comandos por defecto:", error);
                 this.dictationCommands.start = 'tell application "System Events" to key code 63 using {function down}'; // Doble Fn
                 this.dictationCommands.stop = this.dictationCommands.start;
                 return resolve('default');
             }
             const version = stdout.trim(); const majorMinor = version.split('.').slice(0, 2).join('.');
             this.logger.info(`Versión macOS detectada: ${version}`);
             // AJUSTAR COMANDOS BASADO EN PRUEBAS REALES
             if (parseFloat(majorMinor) >= 12) { // Monterey+
                 this.dictationCommands.start = 'tell application "System Events" to key code 104 using {control down}'; // Ejemplo Ctrl+Fn
             } else { // Anterior
                  this.dictationCommands.start = 'tell application "System Events" to key code 49 using {command down, control down, option down}'; // Ejemplo Cmd+Ctrl+Opt+Space
             }
             // Asumir que el mismo comando funciona como toggle para detener
             this.dictationCommands.stop = this.dictationCommands.start;
             this.logger.debug(`Comandos asignados: START/STOP=${this.dictationCommands.start}`);
             resolve(version);
        });
    });
  }

  async _createDictationScripts() {
      try {
        const tmpDir = this.tempFolderPath; await fs.ensureDir(tmpDir);
        const startPath = path.join(tmpDir, 'start_dictation.scpt');
        const stopPath = path.join(tmpDir, 'stop_dictation.scpt');
        const altStartPath = path.join(tmpDir, 'alt_start_dictation.scpt');
        const altStopPath = path.join(tmpDir, 'alt_stop_dictation.scpt');

        // Scripts (con variables incrustadas)
        const startScript = `on run\n set appToUse to "TextEdit"\n try\n tell application appToUse\n activate\n make new document with properties {name:"Dictado_Signia_${Date.now()}"}\n tell application "System Events" to tell process appToUse to set visible to false\n end tell\n delay 0.2\n ${this.dictationCommands.start || '-- Comando START no definido --'}\n delay 0.5\n tell application "System Events"\n try\n keystroke "a" using {command down}\n delay 0.1\n keystroke (ASCII character 8)\n end try\n end tell\n return "OK_TEXTEDIT"\n on error errMsg number errorNumber\n log "Error iniciando TextEdit: " & errMsg & " (" & errorNumber & ")"\n return "ERROR_TEXTEDIT"\n end try\nend run`;
        const stopScript = `on run\n set transcribedText to ""\n set appToUse to "TextEdit"\n ${this.dictationCommands.stop || '-- Comando STOP no definido --'}\n delay 0.5\n try\n tell application appToUse\n if not (exists front document) then return ""\n tell application "System Events"\n keystroke "a" using {command down}\n delay 0.1\n keystroke "c" using {command down}\n end tell\n delay 0.3\n set transcribedText to the clipboard as text\n try\n close front document saving no\n on error\n tell application "System Events"\n try\n keystroke "w" using {command down}\n delay 0.2\n keystroke return\n on error\n try\n key code 51\n end try\n end try\n end tell\n end try\n end tell\n on error errMsg number errorNumber\n log "Error deteniendo TextEdit: " & errMsg & " (" & errorNumber & ")"\n end try\n try\n if (count of windows of application appToUse) is 0 then tell application appToUse to quit\n end try\n return transcribedText\nend run`;
        const altStartScript = `on run\n set appToUse to "Notes"\n try\n tell application appToUse\n activate\n make new note with properties {name:"Dictado_Signia_${Date.now()}"}\n end tell\n delay 0.2\n ${this.dictationCommands.start || '-- Comando START no definido --'}\n delay 0.5\n tell application "System Events"\n try\n keystroke "a" using {command down}\n delay 0.1\n keystroke (ASCII character 8)\n end try\n end tell\n return "OK_NOTES"\n on error errMsg number errorNumber\n log "Error iniciando Notes: " & errMsg & " (" & errorNumber & ")"\n return "ERROR_NOTES"\n end try\nend run`;
        const altStopScript = `on run\n set transcribedText to ""\n set appToUse to "Notes"\n ${this.dictationCommands.stop || '-- Comando STOP no definido --'}\n delay 0.5\n try\n tell application appToUse\n if not (exists note 1) then return ""\n tell application "System Events"\n keystroke "a" using {command down}\n delay 0.1\n keystroke "c" using {command down}\n end tell\n delay 0.3\n set transcribedText to the clipboard as text\n try\n delete note 1\n on error errMsg\n log "No se pudo eliminar nota: " & errMsg\n end try\n end tell\n on error errMsg number errorNumber\n log "Error deteniendo Notes: " & errMsg & " (" & errorNumber & ")"\n end try\n try\n tell application appToUse to quit\n end try\n return transcribedText\nend run`;

        await fs.writeFile(startPath, startScript); await fs.writeFile(stopPath, stopScript);
        await fs.writeFile(altStartPath, altStartScript); await fs.writeFile(altStopPath, altStopScript);
        this.dictationScripts = { start: startPath, stop: stopPath, altStart: altStartPath, altStop: altStopPath };
        this.logger.info('Scripts AppleScript creados.');
      } catch (error) { this.logger.error('Error creando scripts AppleScript:', error); throw error; }
  }

  _runAppleScriptFile(scriptPath) {
    return new Promise((resolve, reject) => {
        const cmd = 'osascript'; const args = [scriptPath]; this.logger.debug(`Ejecutando: ${cmd} "${scriptPath}"`);
        const process = spawn(cmd, args); let stdout = ''; let stderr = '';
        process.stdout.on('data', (data) => stdout += data.toString()); process.stderr.on('data', (data) => stderr += data.toString());
        process.on('close', (code) => { if (code === 0) resolve(stdout.trim()); else reject(new Error(`Script ${path.basename(scriptPath)} falló (${code}): ${stderr.trim() || stdout.trim()}`)); });
        process.on('error', (err) => reject(new Error(`Error spawn ${cmd}: ${err.message}`)));
    });
  }
  _runAppleScriptCommand(scriptContent) {
    return new Promise((resolve, reject) => {
        const cmd = 'osascript'; const args = ['-e', scriptContent]; this.logger.debug(`Ejecutando: ${cmd} -e "..."`);
        const process = spawn(cmd, args); let stdout = ''; let stderr = '';
        process.stdout.on('data', (data) => stdout += data.toString()); process.stderr.on('data', (data) => stderr += data.toString());
        process.on('close', (code) => { if (code === 0) resolve(stdout.trim()); else reject(new Error(`Comando AppleScript falló (${code}): ${stderr.trim() || stdout.trim()}`)); });
        process.on('error', (err) => reject(new Error(`Error spawn ${cmd}: ${err.message}`)));
    });
  }

  async startListening(options = {}) {
    if (this.isListening) { this.logger.warn("Dictado macOS ya activo."); return false; }
    if (!this.isInitialized) throw new Error("MacOSSpeechStrategy no inicializado.");
    if (this.dictationInProgress) { this.logger.warn("Inicio de dictado ya en progreso."); return false; }
    this.logger.info("Solicitud para iniciar dictado macOS...");
    this.dictationInProgress = true; this.retryCount = 0; this.cancelRequested = false;
    this.intermediateTranscriptions = []; this.currentTranscription = '';
    this.emit('dictationPreparing');
    try {
        const success = await this._attemptStartListening(this.dictationScripts.start);
        if (!success && !this.cancelRequested) throw new Error("Fallo el inicio del dictado después de reintentos.");
        return success;
    } catch (error) {
        this.logger.error('Error final iniciando dictado macOS:', error);
        this._cleanupOnError();
        this.emit('dictationError', this._createError('START_FAILED', error.message, error));
        return false;
    } finally { this.dictationInProgress = false; }
  }

  async _attemptStartListening(scriptPathToTry) {
    if (this.cancelRequested) return false;
    this.logger.debug(`Intentando iniciar con: ${path.basename(scriptPathToTry)} (Intento ${this.retryCount + 1}/${this.maxRetries + 1})`);
    try {
        const result = await this._runAppleScriptFile(scriptPathToTry);
        if (result.startsWith('ERROR_')) throw new Error(`Script inicio falló: ${result}`);
        this._setupTranscriptionWatcher(); this.isListening = true; this.emit('dictationStarted'); return true;
    } catch (error) {
        this.logger.warn(`Fallo intento ${this.retryCount + 1} con ${path.basename(scriptPathToTry)}: ${error.message}`);
        this.retryCount++;
        if (this.retryCount <= this.maxRetries && !this.cancelRequested) {
            let nextScript = null;
            if (scriptPathToTry === this.dictationScripts.start && this.dictationScripts.altStart) nextScript = this.dictationScripts.altStart;
            else if (scriptPathToTry === this.dictationScripts.altStart) return await this._retryWithDirectCommands();
            if (nextScript) return await this._attemptStartListening(nextScript);
        }
        this.logger.error("Agotadas estrategias/reintentos para iniciar."); return false;
    }
  }

  async _retryWithDirectCommands() {
      this.logger.info('Intentando iniciar con atajos directos...');
      try {
           const activationScript = `tell application "System Events"\n try\n ${this.dictationCommands.start}\n on error\n try\n key code 63 using {function down}\n delay 0.1\n key code 63 using {function down}\n on error\n error "No se pudo activar dictado"\n end try\n end try\n end tell\n return "OK"`;
           await this._runAppleScriptCommand(activationScript);
           this._setupTranscriptionWatcher(); this.isListening = true; this.emit('dictationStarted'); return true;
      } catch (error) { this.logger.error('Error comandos directos:', error); return false; }
  }

  _setupTranscriptionWatcher() {
    this._cleanupWatchers(); this.logger.debug("Configurando watchers (Clipboard/File)..."); this._setupInactivityTimer();
    const checkClipboard = async () => { /* ... (código igual que antes) ... */ };
    this.watchClipboardInterval = setInterval(checkClipboard, 350);
    if (this.tempFilePath) { try { this.watchFileInterval = fs.watch(this.tempFolderPath, async (evt, fname) => { /* ... (código igual que antes) ... */ }); } catch (watchError) { logger.error("Fallo inicio fs.watch:", watchError); } }
    this.dictationCheckInterval = setInterval(() => this._checkDictationStillActive(), 5000);
  }

  _setupInactivityTimer() { if (this.inactivityTimer) clearTimeout(this.inactivityTimer); this.inactivityTimer = setTimeout(() => this._checkDictationStillActive(true), this.maxInactivityTime); }
  _resetInactivityTimer() { this._setupInactivityTimer(); }
  _addIntermediateTranscription(text) { if (!text) return; const last = this.intermediateTranscriptions.at(-1); if (!last || text !== last) { this.intermediateTranscriptions.push(text); if (this.intermediateTranscriptions.length > this.maxIntermediateTranscriptions) this.intermediateTranscriptions.shift(); } }

  async _checkDictationStillActive(fromInactivityTimer = false) {
     if (!this.isListening || this.cancelRequested) return;
     try {
         const isActive = await this._isDictationServiceRunning();
         if (!isActive) { this.logger.warn('Servicio macOS detenido inesperadamente.'); const lastValid = this.intermediateTranscriptions.at(-1) || this.currentTranscription; this._cleanupOnError(); this.emit('dictationStopped', lastValid); this.emit('dictationError', this._createError('UNEXPECTED_STOP', 'Dictado detenido inesperadamente.')); }
         else if (fromInactivityTimer) { this.logger.warn('Inactividad detectada.'); this.emit('dictationInactive', 'Dictado inactivo. Hable o reinicie.'); this._resetInactivityTimer(); }
     } catch (error) { logger.error('Error check estado dictado:', error); }
  }

  async stopListening() {
     if (!this.isListening) { return this.currentTranscription; }
     this.logger.info("Solicitud stop dictado macOS...");
     this.cancelRequested = true; const backup = this.currentTranscription; let final = ''; this._cleanupWatchers();
     try {
        const script = (this.retryCount > 0 && this.dictationScripts.altStop) ? this.dictationScripts.altStop : this.dictationScripts.stop;
        final = await this._runAppleScriptFile(script).catch(async (err) => { this.logger.warn(`Error script stop (${path.basename(script)}): ${err.message}. Intentando alternativa...`); return await this._stopDictationAlternative(); });
        if (!final) { this.logger.warn("Stop script no devolvió texto. Leyendo archivo/buffer..."); try { const file = this.tempFilePath ? await fs.readFile(this.tempFilePath, 'utf8') : ''; const lastInter = this.intermediateTranscriptions.at(-1) || ''; if (file.length >= lastInter.length && file.length >= backup.length) final = file; else if (lastInter.length >= backup.length) final = lastInter; else final = backup; } catch (e) { this.logger.error("Error leyendo archivo/buffer en stop:", e); final = backup; } }
     } catch (error) { this.logger.error("Error complejo stopListening:", error); final = backup; }
     finally { this.currentTranscription = final || ''; this._cleanup(); this.emit('dictationStopped', this.currentTranscription); this.dictationInProgress = false; this.isListening = false; this.cancelRequested = false; this.retryCount = 0; }
     return this.currentTranscription;
  }

  async _stopDictationAlternative() {
     logger.info('Usando stop alternativo (Escape)...'); const script = `tell application "System Events" to key code 53\ndelay 0.3\ntry\n tell application "System Events"\n keystroke "a" using {command down}\n delay 0.1\n keystroke "c" using {command down}\n end try\n end try\ntry\n return (the clipboard as text)\n on error\n return ""\n end try`;
     return await this._runAppleScriptCommand(script).catch(async (err) => { logger.warn(`Error stop alternativo: ${err.message}. Forzando...`); return await this._forceStopDictation(); });
  }

  async _forceStopDictation() {
     logger.warn('Forzando stop dictado...'); const script = `repeat 3 times\n tell application "System Events" to key code 53\n delay 0.2\n end repeat\ntry\n tell application "System Events" to key code 53 using {function down}\n end try\ntry\n tell application "System Events" to key code 104 using {control down}\n end try\ndelay 0.2\ntry\n tell application "System Events"\n keystroke "a" using {command down}\n delay 0.1\n keystroke "c" using {command down}\n end try\n end try\ntry\n return (the clipboard as text)\n on error\n return ""\n end try`;
     return await this._runAppleScriptCommand(script).catch(err => { logger.error('Fallo al forzar:', err); return ""; });
  }

   _cleanupWatchers() {
        if (this.watchClipboardInterval) clearInterval(this.watchClipboardInterval);
        if (this.watchFileInterval) this.watchFileInterval.close(); // fs.watch devuelve FSWatcher
        if (this.dictationCheckInterval) clearInterval(this.dictationCheckInterval);
        if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
        this.watchClipboardInterval = null; this.watchFileInterval = null; this.dictationCheckInterval = null; this.inactivityTimer = null;
   }

  _cleanup() { // Limpieza interna llamada por stop o error
     this._cleanupWatchers();
     if (this.recognitionProcess) { try { this.recognitionProcess.kill(); } catch {} this.recognitionProcess = null; }
     exec('osascript -e \'tell application "TextEdit" to quit saving no\' &> /dev/null').catch(()=>{}); // Intentar cerrar apps en segundo plano
     exec('osascript -e \'tell application "Notes" to quit saving no\' &> /dev/null').catch(()=>{});
     this.isListening = false; // Asegurar estado
  }

  _cleanupOnError() { // Limpieza específica en caso de error irrecuperable
        this._cleanupWatchers();
        if (this.recognitionProcess) { try { this.recognitionProcess.kill(); } catch {} this.recognitionProcess = null; }
        this.isListening = false; this.dictationInProgress = false; this.cancelRequested = false;
        // No cerrar apps aquí para posible inspección manual
   }


  cleanup() { // Limpieza final de la instancia del servicio
    this.logger.info('Limpiando MacOSSpeechStrategy...');
    this.stopListening().catch(() => {}); // Intentar detener si aún corre
    this._cleanup(); // Limpieza interna final
    if (this.tempFolderPath && this.tempFolderPath !== os.tmpdir()) {
      fs.remove(this.tempFolderPath).then(() => this.logger.debug("Carpeta temporal eliminada."))
                                    .catch(err => this.logger.warn('Error eliminando carpeta temp:', err));
    }
    this.removeAllListeners();
    this.isInitialized = false;
    this.logger.info('MacOSSpeechStrategy limpiado.');
  }

   _createError(type, message, nativeError = null) {
      const error = new Error(message); error.type = type || 'MACOS_STRATEGY_ERROR';
      if (nativeError) { error.nativeError = nativeError; if(!error.stack && nativeError.stack) error.stack = nativeError.stack; }
      return error;
   }
}

module.exports = MacOSSpeechStrategy;