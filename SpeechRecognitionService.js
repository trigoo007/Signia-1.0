const { EventEmitter } = require('events');
const os = require('os');
const logger = require('../utils/logger');
const MacOSSpeechStrategy = require('../strategies/MacOSSpeechStrategy');
const WindowsSpeechStrategy = require('../strategies/WindowsSpeechStrategy');
const WebSpeechStrategy = require('../strategies/WebSpeechStrategy');
const DictaphoneHandler = require('../hardware/DictaphoneHandler');
const ERROR_TYPES = require('../utils/error-types');

class SpeechRecognitionService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.dbManager = options.dbManager;
    this.mainWindow = options.mainWindow;
    this.preferredStrategy = options.preferredStrategy || null;
    this.enableDictaphone = options.enableDictaphone !== false;
    this.language = options.language || 'es-ES';
    this.activeStrategy = null;
    this.dictaphoneHandler = options.dictaphoneHandler || null; // Acepta handler inyectado
    this.isInitialized = false; this.isListening = false; this.currentTranscription = '';
  }

  async initialize(mainWindow) {
    if (this.isInitialized) return true;
    this.logger.info('Inicializando SpeechRecognitionService...');
    if (mainWindow && !this.mainWindow) this.mainWindow = mainWindow;
    try {
      if (this.enableDictaphone && !this.dictaphoneHandler) await this._initializeDictaphoneHandler();
      else if (this.dictaphoneHandler) this._setupDictaphoneListeners();
      else this.logger.info('Dictáfono deshabilitado.');

      this.activeStrategy = this._selectStrategy();
      if (!this.activeStrategy) throw this._createError(ERROR_TYPES.SPEECH_INIT_ERROR,'No se pudo seleccionar estrategia de voz compatible.');
      this.logger.info(`Estrategia seleccionada: ${this.activeStrategy.constructor.name}`);
      await this.activeStrategy.initialize({ language: this.language });
      this._setupStrategyListeners();
      this.isInitialized = true; this.logger.info(`SpeechRecognitionService inicializado con ${this.activeStrategy.constructor.name}.`); return true;
    } catch (error) {
        const structuredError = this._createError(error.type || ERROR_TYPES.SPEECH_INIT_ERROR, `Fallo init SR: ${error.message}`, { critical: error.critical !== false, nativeError: error });
        this.logger.error(`Error inicializando SpeechRecognitionService: ${structuredError.message}`);
        this.emit('error', structuredError); throw structuredError;
    }
  }

  async _initializeDictaphoneHandler() {
    this.logger.info('Inicializando DictaphoneHandler internamente...');
    try {
      this.dictaphoneHandler = new DictaphoneHandler({ logger: this.logger, dbManager: this.dbManager });
      // await this.dictaphoneHandler.initialize(); // Si tu handler tiene init
      this._setupDictaphoneListeners();
      this.logger.info('DictaphoneHandler inicializado por SpeechService.');
      await this.dictaphoneHandler.findAndConnect(); // Intentar conectar al inicio
    } catch (error) {
        this.logger.error(`Error inicializando DictaphoneHandler: ${error.message}`);
        this.emit('error', this._createError(ERROR_TYPES.DICTAPHONE_INIT_ERROR, `Fallo init dictáfono: ${error.message}`, { critical: false, nativeError: error }));
        this.dictaphoneHandler = null; // Asegurar que es null si falla
    }
  }

  _selectStrategy() {
    const platform = os.platform(); let strategy = null;
    this.logger.debug(`Seleccionando estrategia: Preferida=${this.preferredStrategy}, OS=${platform}`);
    // 1. Intentar preferida
    if (this.preferredStrategy) {
        if (this.preferredStrategy === 'macos' && platform === 'darwin') strategy = new MacOSSpeechStrategy({ logger: this.logger });
        else if (this.preferredStrategy === 'windows' && platform === 'win32') strategy = new WindowsSpeechStrategy({ logger: this.logger });
        else if (this.preferredStrategy === 'web' && this.mainWindow) strategy = new WebSpeechStrategy(this.mainWindow, { logger: this.logger });
        if (strategy) { this.logger.info(`Usando estrategia preferida: ${this.preferredStrategy}`); return strategy; }
        else this.logger.warn(`Preferencia '${this.preferredStrategy}' no compatible/falló. Auto-detectando...`);
    }
    // 2. Auto-detección OS
    if (platform === 'darwin') strategy = new MacOSSpeechStrategy({ logger: this.logger });
    else if (platform === 'win32') strategy = new WindowsSpeechStrategy({ logger: this.logger });
    // 3. Fallback a WebSpeech
    if (!strategy) {
        if (!this.mainWindow) { this.logger.error("WebSpeech (fallback) requiere mainWindow."); return null; }
        strategy = new WebSpeechStrategy(this.mainWindow, { logger: this.logger });
    }
    return strategy;
  }

  _setupStrategyListeners() {
    if (!this.activeStrategy) return;
    this.activeStrategy.on('dictationStarted', () => { this.isListening = true; this.currentTranscription = ''; this.emit('dictationStarted'); });
    this.activeStrategy.on('transcriptionUpdate', (data) => { if (data?.original) this.currentTranscription = data.original; this.emit('transcriptionUpdate', data); });
    this.activeStrategy.on('dictationStopped', (finalTranscription) => { this.isListening = false; this.currentTranscription = finalTranscription ?? this.currentTranscription; this.emit('dictationStopped', this.currentTranscription); });
    this.activeStrategy.on('dictationError', (error) => { this.isListening = false; const structErr = this._createError(ERROR_TYPES.SPEECH_RECOGNITION, `Error en ${this.activeStrategy.constructor.name}: ${error.message || error}`, { critical: false, nativeError: error }); this.emit('error', structErr); this.emit('dictationError', structErr); });
    this.activeStrategy.on('dictationNeedsUserSetup', (message) => { this.logger.warn(`Setup manual requerido: ${message}`); this.emit('needsUserSetup', { service: 'dictation', message }); });
    this.activeStrategy.on('metrics', (metricsData) => this.emit('metrics', metricsData));
  }

  _setupDictaphoneListeners() {
    if (!this.dictaphoneHandler) return;
    this.dictaphoneHandler.on('dictaphoneConnected', (data) => this.emit('dictaphoneConnected', data)); // Pasa el objeto {device, config}
    this.dictaphoneHandler.on('dictaphoneDisconnected', (data) => this.emit('dictaphoneDisconnected', data));
    this.dictaphoneHandler.on('dictaphoneAction', (action) => this.emit('dictaphoneAction', action));
    this.dictaphoneHandler.on('dictaphoneError', (error) => this.emit('dictaphoneError', error));
    this.dictaphoneHandler.on('dictaphoneReconnecting', (data) => this.emit('dictaphoneReconnecting', data));
    this.dictaphoneHandler.on('dictaphoneReconnectFailed', (data) => this.emit('dictaphoneReconnectFailed', data));
  }

  async startListening(options = {}) {
    if (!this.isInitialized || !this.activeStrategy) throw new Error('SR no inicializado.');
    if (this.isListening) { this.logger.warn("Dictado ya activo."); return; }
    await this.activeStrategy.startListening({ language: this.language, ...options });
  }

  async stopListening() {
    if (!this.isInitialized || !this.activeStrategy) throw new Error('SR no inicializado.');
    if (!this.isListening) { this.logger.warn("Dictado no activo."); return this.currentTranscription; }
    return await this.activeStrategy.stopListening();
  }

  // --- Métodos delegados a DictaphoneHandler ---
  getConnectedDictaphones() { return this.dictaphoneHandler?.getConnectedDevices() || []; }
  async setActiveDictaphone(devicePath) { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); return await this.dictaphoneHandler.findAndConnect(devicePath); }
  getActiveDictaphoneInfo() { if (!this.dictaphoneHandler) return { isConnected: false, device: null }; const dev = this.dictaphoneHandler.getActiveDevice(); return { isConnected: !!dev, device: dev }; }
  async saveDictaphoneConfig(config) { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); /* Podría necesitar lógica para asignar antes de guardar */ return await this.dictaphoneHandler.saveConfig(); }
  getDefaultMappings(modelName, productId) { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); return this.dictaphoneHandler.getDefaultMappings(modelName, productId); }

  async cleanup() {
    this.logger.info('Limpiando SpeechRecognitionService...');
    if (this.activeStrategy) { try { await this.activeStrategy.cleanup(); } catch (e) { this.logger.error('Error limpiando estrategia:', e); } }
    if (this.dictaphoneHandler) { try { await this.dictaphoneHandler.cleanup(); } catch (e) { this.logger.error('Error limpiando handler:', e); } }
    this.activeStrategy = null; this.dictaphoneHandler = null;
    this.removeAllListeners(); this.isInitialized = false; this.isListening = false;
    this.logger.info('SpeechRecognitionService limpiado.');
  }

  _createError(type, message, details = {}) {
    const error = new Error(message); error.type = type || ERROR_TYPES.UNKNOWN; error.timestamp = Date.now();
    error.id = details.id || `${error.type}_${Date.now()}`; error.critical = details.critical === true; error.details = details.details || {};
    if(details.nativeError) { error.details.nativeError = details.nativeError; if (!error.stack && details.nativeError instanceof Error) error.stack = details.nativeError.stack; }
    return error;
  }
}

module.exports = SpeechRecognitionService;