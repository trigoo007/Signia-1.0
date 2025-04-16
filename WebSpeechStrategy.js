const { EventEmitter } = require('events');
const { ipcMain } = require('electron');
const logger = require('../utils/logger');
const { performance } = require('perf_hooks');
const ERROR_TYPES = require('../utils/error-types'); // Importar tipos de error

// Asumiendo clase base
class SpeechRecognitionStrategy extends EventEmitter {
  constructor() { super(); this.isInitialized = false; this.isListening = false; }
  async initialize(options) { throw new Error('Method not implemented'); }
  async startListening(options) { throw new Error('Method not implemented'); }
  async stopListening() { throw new Error('Method not implemented'); }
  cleanup() { throw new Error('Method not implemented'); }
}

class WebSpeechStrategy extends SpeechRecognitionStrategy {
  constructor(mainWindow, options = {}) {
    super();
    this.logger = options.logger || logger;
    this.mainWindow = mainWindow;
    this.isListening = false;
    this.isInitialized = false;
    this.currentLanguage = options.language || 'es-ES';
    this.metrics = { startTime: 0, stopTime: 0, totalDictationTime: 0, errors: 0, updatesReceived: 0 };
    // Guardar referencias a handlers para poder removerlos en cleanup
    this.ipcResultHandler = this._handleWebSpeechResult.bind(this);
    this.ipcErrorHandler = this._handleWebSpeechError.bind(this);
    this.ipcEndHandler = this._handleWebSpeechEnd.bind(this);
  }

  async initialize(options = {}) {
     if (this.isInitialized) return true; this.logger.info('Inicializando WebSpeechStrategy...');
     if (!this.mainWindow || this.mainWindow.isDestroyed()) throw this._createError(ERROR_TYPES.SPEECH_INIT_ERROR, 'WebSpeechStrategy requiere mainWindow.');
     if (!this.mainWindow.webContents || this.mainWindow.webContents.isDestroyed()) throw this._createError(ERROR_TYPES.SPEECH_INIT_ERROR, 'WebSpeechStrategy requiere webContents válidos.');
     this.currentLanguage = options.language || this.currentLanguage;
     // Configurar listeners IPC desde el renderer
     ipcMain.on('web-speech-result', this.ipcResultHandler);
     ipcMain.on('web-speech-error', this.ipcErrorHandler);
     ipcMain.on('web-speech-end', this.ipcEndHandler);
     // Verificar si renderer está listo (opcional)
     // Podríamos usar un invoke('is-web-speech-ready') si el preload lo expone
     this.isInitialized = true; this.logger.info('WebSpeechStrategy inicializado.'); return true;
  }

  async startListening(options = {}) {
    if (this.isListening) { this.logger.warn('WebSpeech ya está escuchando.'); return false; }
    if (!this.isInitialized) throw this._createError(ERROR_TYPES.SPEECH_STRATEGY_ERROR, "WebSpeechStrategy no inicializado.");
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.webContents || this.mainWindow.webContents.isDestroyed()) throw this._createError(ERROR_TYPES.SPEECH_STRATEGY_ERROR, "Ventana no disponible para iniciar WebSpeech.");
    this.currentLanguage = options.language || this.currentLanguage;
    this.logger.info(`Iniciando WebSpeech (lang: ${this.currentLanguage})...`);
    this.metrics.startTime = performance.now();
    try {
      this.mainWindow.webContents.send('start-web-speech', { lang: this.currentLanguage }); // Comando a renderer
      this.isListening = true; this.emit('dictationStarted'); return true;
    } catch (error) { this.logger.error('Error enviando start-web-speech:', error); this.emit('dictationError', this._createError(ERROR_TYPES.IPC_ERROR, `Error iniciando: ${error.message}`, {nativeError: error})); return false; }
  }

  async stopListening() {
      if (!this.isListening) { this.logger.warn('WebSpeech no estaba escuchando.'); return ""; }
      if (!this.isInitialized) { this.logger.error("WebSpeech no inicializado al detener."); return ""; }
      if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.webContents || this.mainWindow.webContents.isDestroyed()) { this.logger.error("Ventana no disponible para detener WebSpeech."); this.isListening = false; return ""; }
      this.logger.info('Deteniendo WebSpeech...');
      try {
          this.mainWindow.webContents.send('stop-web-speech'); // Comando a renderer
          this.isListening = false; this.metrics.stopTime = performance.now();
          // Esperar evento 'web-speech-end' para el resultado final
          return true; // Indica que se envió la solicitud
      } catch (error) { this.logger.error('Error enviando stop-web-speech:', error); this.isListening = false; this.emit('dictationError', this._createError(ERROR_TYPES.IPC_ERROR, `Error deteniendo: ${error.message}`, {nativeError: error})); return false; }
  }

  // --- Manejadores de eventos IPC desde Renderer ---
  _handleWebSpeechResult(event, result) {
    if (!this.isListening) return; // Ignorar si no esperamos resultados
    if (result?.transcript !== undefined) { // Verificar que al menos transcript exista
        //this.logger.debug(`WebSpeech Result (isFinal: ${result.isFinal}): "${result.transcript.substring(0, 30)}..."`);
        this.metrics.updatesReceived++;
        this.emit('transcriptionUpdate', { original: result.transcript, processed: result.transcript, isFinal: result.isFinal || false });
    } else {
        this.logger.warn("Resultado WebSpeech inválido recibido:", result);
    }
  }

  _handleWebSpeechError(event, errorData) {
    const errorMessage = errorData?.message || errorData?.error || 'Error desconocido WebSpeech (renderer)';
    this.logger.error(`Error WebSpeech API (renderer): ${errorMessage}`);
    if (this.isListening) { // Solo si afecta una sesión activa
        this.metrics.errors++; this.isListening = false;
        const error = this._createError(ERROR_TYPES.SPEECH_RECOGNITION, errorMessage, { details: errorData });
        this.emit('dictationError', error); // Emitir error estructurado
        if (this.metrics.startTime > 0) { this.metrics.stopTime = performance.now(); this.metrics.totalDictationTime += (this.metrics.stopTime - this.metrics.startTime) / 1000; this.emit('metrics', { ...this.metrics }); this.metrics.startTime = 0; }
    }
  }

  _handleWebSpeechEnd(event, finalTranscript) {
    //this.logger.debug('WebSpeech API reportó fin desde renderer.');
    if (this.isListening) { // Evitar dobles stops si stopListening() ya puso isListening=false
         this.isListening = false;
        if (this.metrics.startTime > 0) { this.metrics.stopTime = performance.now(); this.metrics.totalDictationTime += (this.metrics.stopTime - this.metrics.startTime) / 1000; this.emit('metrics', { ...this.metrics }); this.metrics.startTime = 0; }
        this.emit('dictationStopped', finalTranscript || ''); // Emitir evento final
    } else {
        // this.logger.debug("Recibido web-speech-end pero ya no estábamos 'listening'.");
    }
  }

  cleanup() {
      this.logger.info('Limpiando WebSpeechStrategy...');
      if (this.isListening) this.stopListening().catch(e => this.logger.warn("Error deteniendo WebSpeech durante cleanup:", e));
      // Remover listeners IPC específicos
      ipcMain.removeListener('web-speech-result', this.ipcResultHandler);
      ipcMain.removeListener('web-speech-error', this.ipcErrorHandler);
      ipcMain.removeListener('web-speech-end', this.ipcEndHandler);
      this.removeAllListeners(); // Limpiar listeners propios
      this.isInitialized = false; this.isListening = false; this.mainWindow = null;
      this.logger.info('WebSpeechStrategy limpiado.');
  }

   // Helper de errores interno
   _createError(type, message, details = {}) {
    const error = new Error(message); error.type = type || ERROR_TYPES.SPEECH_STRATEGY_ERROR; error.timestamp = Date.now();
    error.id = details.id || `${error.type}_${Date.now()}`; error.critical = details.critical === true; error.details = details.details || {};
    if(details.nativeError) { error.details.nativeError = details.nativeError; if (!error.stack && details.nativeError instanceof Error) error.stack = details.nativeError.stack; }
    return error;
  }
}

module.exports = WebSpeechStrategy;