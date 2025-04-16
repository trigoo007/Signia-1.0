const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const ERROR_TYPES = require('../utils/error-types');
const { performance } = require('perf_hooks');

// Asumiendo clase base
class SpeechRecognitionStrategy extends EventEmitter {
  constructor() { super(); this.isInitialized = false; this.isListening = false; }
  async initialize(options) { throw new Error('Method not implemented'); }
  async startListening(options) { throw new Error('Method not implemented'); }
  async stopListening() { throw new Error('Method not implemented'); }
  cleanup() { throw new Error('Method not implemented'); }
}

// --- Contenido del Script de PowerShell (Conceptual) ---
const POWERSHELL_SCRIPT_CONTENT = `
#Requires -Version 5.1
#Requires -Modules System.Speech
param( [string]$Culture = 'es-ES' )
try {
    Add-Type -AssemblyName System.Speech
    $ErrorActionPreference = 'Stop' # Detener script en errores graves
    $global:recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine( [System.Globalization.CultureInfo]::new($Culture) )
} catch {
    Write-Error "FATAL: No se pudo cargar System.Speech o crear el motor de reconocimiento. Asegúrese que .NET Framework está instalado y el idioma es compatible."
    exit 1
}

try {
    $dictationGrammar = New-Object System.Speech.Recognition.DictationGrammar
    $recognizer.LoadGrammar($dictationGrammar)

    # Evento para resultado final reconocido
    Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -Action {
        $text = $EventArgs.Result.Text
        # Enviar con prefijo para parseo fácil
        Write-Host "FINAL: $($text)"
        # Limpiar consola/flush puede ser necesario
        # [Console]::Out.Flush()
    } | Out-Null

    # Evento para hipótesis/resultados intermedios (opcional)
    # Register-ObjectEvent -InputObject $recognizer -EventName SpeechHypothesized -Action { Write-Host "INTERIM: $($EventArgs.Result.Text)" } | Out-Null

    # Evento para errores/completado
     Register-ObjectEvent -InputObject $recognizer -EventName RecognizeCompleted -Action {
         if ($EventArgs.Error) { Write-Error "ERROR: $($EventArgs.Error.Message)" }
         # Podríamos añadir lógica aquí si es necesario al completar un reconocimiento
     } | Out-Null
     Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognitionRejected -Action { Write-Host "INFO: Speech rejected (confidence too low?)" } | Out-Null


    # Configurar entrada de audio por defecto
    $recognizer.SetInputToDefaultAudioDevice()

    # Iniciar reconocimiento asíncrono múltiple
    Write-Host "INFO: Iniciando reconocimiento para cultura $Culture..."
    $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    Write-Host "INFO: Reconocimiento iniciado. Esperando audio..."

    # Bucle para mantener el script vivo y escuchar stdin para comando de parada
    while ($true) {
        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            # Si se recibe 'q' (o cualquier señal), detener y salir
            if ($key.KeyChar -eq 'q') {
                Write-Host "INFO: Recibida señal de parada."
                break
            }
        }
        Start-Sleep -Milliseconds 200 # Pequeña pausa para no consumir 100% CPU
    }

} catch {
    Write-Error "FATAL: Error durante configuración o ejecución: $($_.Exception.Message)"
    exit 1
} finally {
    # Asegurar limpieza al salir del bucle o por error
    Write-Host "INFO: Deteniendo reconocimiento y limpiando..."
    if ($global:recognizer) {
        try { $recognizer.RecognizeAsyncStop() } catch {}
        try { $recognizer.Dispose() } catch {}
    }
    Write-Host "INFO: Script finalizado."
    exit 0 # Salir limpiamente
}
`;

class WindowsSpeechStrategy extends SpeechRecognitionStrategy {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.language = options.language || 'es-ES';
    this.dictationProcess = null; this.scriptPath = null; this.lastTranscription = '';
    this.isListening = false; this.isInitialized = false;
    this.metrics = { startTime: 0, stopTime: 0, totalDictationTime: 0, errors: 0, updatesReceived: 0 };
  }

  async initialize(options = {}) {
    if (this.isInitialized) return true;
    this.logger.info('Inicializando WindowsSpeechStrategy...');
    this.language = options.language || this.language;
    if (os.platform() !== 'win32') throw new Error('WindowsSpeechStrategy solo funciona en Windows.');
    const requirementsMet = await this._checkRequirements();
    if (!requirementsMet) { this.emit('dictationNeedsUserSetup', 'Se requiere PowerShell 5.1+ y .NET Framework con System.Speech.'); throw new Error('Requisitos Windows Speech no cumplidos.'); }
    try { // Crear script temporal
      const scriptDir = path.join(os.tmpdir(), 'signia_speech_scripts'); await fs.ensureDir(scriptDir);
      this.scriptPath = path.join(scriptDir, 'start_recognition.ps1'); await fs.writeFile(this.scriptPath, POWERSHELL_SCRIPT_CONTENT, 'utf8');
      this.logger.debug(`Script PS creado: ${this.scriptPath}`);
    } catch (error) { this.logger.error('Error creando script PS:', error); throw this._createError(ERROR_TYPES.FILESYSTEM_ERROR, `Fallo creando script: ${error.message}`, { nativeError: error }); }
    this.isInitialized = true; this.logger.info('WindowsSpeechStrategy inicializado.'); return true;
  }

  async _checkRequirements() {
    this.logger.debug("Verificando PowerShell 5.1+...");
    return new Promise((resolve) => {
        // Usar -NonInteractive para evitar problemas en entornos sin UI
        const psCheck = spawn('powershell.exe', ['-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major -ge 5']);
        let output = '';
        psCheck.stdout.on('data', (data) => output += data.toString());
        psCheck.on('error', (err) => { this.logger.warn(`Error ejecutando PowerShell: ${err.message}`); resolve(false); });
        psCheck.on('close', (code) => {
             if (code === 0 && output.trim().toLowerCase() === 'true') { this.logger.debug("PowerShell 5.1+ OK."); resolve(true); }
             else { this.logger.warn(`Check PS falló (code ${code}) o versión < 5.1 (output: ${output.trim()}).`); resolve(false); }
        });
    });
  }

  async startListening(options = {}) {
    if (!this.isInitialized) throw new Error('WindowsSpeechStrategy no inicializado.');
    if (this.isListening) { this.logger.warn('Dictado Windows ya activo.'); return false; }
    this.language = options.language || this.language;
    this.logger.info(`Iniciando dictado Windows (Idioma: ${this.language}). Script: ${this.scriptPath}`);
    this.metrics.startTime = performance.now(); this.lastTranscription = '';

    try {
      // '-NoProfile' puede acelerar un poco el inicio
      const args = [ '-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', this.scriptPath, '-Culture', this.language ];
      this.dictationProcess = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'] }); // stdin, stdout, stderr

      this.isListening = true; this.emit('dictationStarted'); // Emitir inicio

      // Manejar salida estándar
      this.dictationProcess.stdout.on('data', (data) => { data.toString().trim().split(/[\r\n]+/).forEach(line => this._processRecognizerOutput(line)); });
      // Manejar errores estándar
      this.dictationProcess.stderr.on('data', (data) => {
          const errorMsg = data.toString().trim();
          // Filtrar errores fatales del script de errores de reconocimiento
          if (errorMsg.startsWith('FATAL:')) {
               this.logger.error(`Error FATAL script PS: ${errorMsg}`);
               // Considerar detener si es fatal
               this.stopListening().catch(()=>{}); // Intentar detener limpiamente
               this.emit('dictationError', this._createError(ERROR_TYPES.SPEECH_STRATEGY_ERROR, `Error fatal script PS: ${errorMsg}`));
          } else {
               this.logger.warn(`Stderr script PS: ${errorMsg}`); // Loguear otros errores como warning
          }
      });
      // Manejar cierre
      this.dictationProcess.on('close', (code) => {
        this.logger.warn(`Proceso PS terminado código: ${code}`);
        if (this.isListening) { // Cierre inesperado
             this.isListening = false; this.metrics.errors++;
             const error = this._createError(ERROR_TYPES.SPEECH_RECOGNITION, `Proceso reconocimiento terminó inesperadamente (código ${code})`, { exitCode: code });
             this.emit('dictationError', error); this.emit('dictationStopped', this.lastTranscription); // Emitir stop con lo último
             this._calculateAndEmitMetricsOnError();
        } this.dictationProcess = null;
      });
      // Manejar error al spawn
      this.dictationProcess.on('error', (err) => {
        this.logger.error(`Error al spawn PowerShell: ${err.message}`); this.isListening = false; this.metrics.errors++;
        const error = this._createError(ERROR_TYPES.SPEECH_INIT_ERROR, `Fallo spawn PS: ${err.message}`, { nativeError: err });
        this.emit('dictationError', error); this.dictationProcess = null; this._calculateAndEmitMetricsOnError();
      });
      return true;
    } catch (error) {
      this.logger.error('Excepción iniciando dictado Windows:', error); this.isListening = false; this.metrics.errors++;
      const structErr = this._createError(ERROR_TYPES.SPEECH_INIT_ERROR, `Fallo lanzando PS: ${error.message}`, { nativeError: error });
      this.emit('dictationError', structErr); return false;
    }
  }

  _processRecognizerOutput(line) {
     if (!line) return;
     // this.logger.debug(`PS Line: ${line}`);
     try {
        if (line.startsWith('FINAL:')) { const text = line.substring(6).trim(); this.lastTranscription = text; this.metrics.updatesReceived++; this.emit('transcriptionUpdate', { original: text, processed: text, isFinal: true }); }
        else if (line.startsWith('INTERIM:')) { const text = line.substring(8).trim(); this.metrics.updatesReceived++; this.emit('transcriptionUpdate', { original: text, processed: text, isFinal: false }); }
        else if (line.startsWith('ERROR:')) { const errorMsg = line.substring(6).trim(); this.logger.error(`Error reconocimiento PS: ${errorMsg}`); this.metrics.errors++; const error = this._createError(ERROR_TYPES.SPEECH_RECOGNITION, `Error reconocimiento: ${errorMsg}`); this.emit('dictationError', error); }
        else if (line.startsWith('INFO:')) { this.logger.debug(`Info PS: ${line.substring(5).trim()}`); }
     } catch(e) { this.logger.error("Error procesando salida PS:", e, "Linea:", line); }
  }

  async stopListening() {
    if (!this.isListening || !this.dictationProcess) { this.logger.warn('Dictado Windows no activo.'); return this.lastTranscription; }
    this.logger.info('Deteniendo dictado Windows...'); this.isListening = false;
    try {
      // Enviar comando 'q' al stdin del proceso para que termine limpiamente
      if (this.dictationProcess.stdin.writable) {
          this.dictationProcess.stdin.write("q\n"); // Envía 'q' seguido de newline
          this.dictationProcess.stdin.end(); // Cierra stdin
          this.logger.debug("Señal 'q' enviada a stdin de PowerShell.");
      } else {
           this.logger.warn("Stdin de PowerShell no disponible, forzando cierre (kill)...");
           this.dictationProcess.kill(); // Fallback si stdin no funciona
      }
      // Esperar un poco a que el proceso termine solo? O asumir que se cerrará
      // El listener 'close' se encargará de limpiar this.dictationProcess
      // Calcular métricas
       if (this.metrics.startTime > 0) { this.metrics.stopTime = performance.now(); this.metrics.totalDictationTime += (this.metrics.stopTime - this.metrics.startTime) / 1000; this.emit('metrics', { ...this.metrics }); this.metrics.startTime = 0; }
      // Emitir 'stopped' inmediatamente. Si el proceso envía algo más antes de cerrar, se ignora.
      this.emit('dictationStopped', this.lastTranscription);
      return this.lastTranscription;
    } catch (error) {
      this.logger.error('Error deteniendo proceso PS:', error);
      if (this.dictationProcess) { try { this.dictationProcess.kill(); } catch {} } // Asegurar kill si falla stdin
      this.dictationProcess = null;
      const structErr = this._createError(ERROR_TYPES.SPEECH_RECOGNITION, `Fallo detener proceso: ${error.message}`, { nativeError: error });
      this.emit('dictationError', structErr); this.emit('dictationStopped', this.lastTranscription); return this.lastTranscription;
    }
  }

  _calculateAndEmitMetricsOnError() {
      if (this.metrics.startTime > 0) { this.metrics.stopTime = performance.now(); this.metrics.totalDictationTime += (this.metrics.stopTime - this.metrics.startTime) / 1000; this.emit('metrics', { ...this.metrics }); this.metrics.startTime = 0; }
  }

  cleanup() {
    this.logger.info('Limpiando WindowsSpeechStrategy...');
    if (this.dictationProcess) { this.logger.debug('Deteniendo proceso PS en cleanup...'); if(this.dictationProcess.stdin.writable) { this.dictationProcess.stdin.write("q\n"); this.dictationProcess.stdin.end(); } else { this.dictationProcess.kill(); } this.dictationProcess = null; }
    if (this.scriptPath) { fs.unlink(this.scriptPath).then(() => this.logger.debug(`Script PS eliminado: ${this.scriptPath}`)).catch(err => this.logger.warn(`Error eliminando script PS ${this.scriptPath}:`, err)); this.scriptPath = null; }
    this.removeAllListeners(); this.isInitialized = false; this.isListening = false;
    this.logger.info('WindowsSpeechStrategy limpiado.');
  }

   _createError(type, message, details = {}) {
      const error = new Error(message); error.type = type || ERROR_TYPES.SPEECH_STRATEGY_ERROR; error.timestamp = Date.now(); error.id = `${error.type}_${Date.now()}`; error.critical = details.critical === true; error.details = details.details || {};
      if(details.nativeError) { error.details.nativeError = details.nativeError; if (!error.stack && details.nativeError instanceof Error) error.stack = details.nativeError.stack; }
      if(details.exitCode !== undefined) error.details.exitCode = details.exitCode; return error;
   }
}

module.exports = WindowsSpeechStrategy;