const { EventEmitter } = require('events');
const { dialog, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// Importar servicios y utilidades
const DatabaseManager = require('./services/DatabaseManager');
const SpeechRecognitionService = require('./services/SpeechRecognitionService');
const MedicalTermReplacementService = require('./services/MedicalTermReplacementService'); // Tu versión optimizada
const OllamaService = require('./services/OllamaService');
const ApplicationPrecheck = require('./utils/ApplicationPrecheck');
const SystemRequirementsChecker = require('./utils/SystemRequirementsChecker');
const ERROR_TYPES = require('./utils/error-types');
const logger = require('./utils/logger');
const DictaphoneHandler = require('../hardware/DictaphoneHandler'); // Tu versión mejorada

class RadiologistAppController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.app = options.app || app;
    this.mainWindow = options.mainWindow || null;
    this.isDevelopment = options.isDevelopment || process.env.NODE_ENV === 'development';

    // Servicios
    this.dbManager = null;
    this.speechService = null;
    this.termReplacementService = null; // Referencia a tu versión optimizada
    this.ollamaService = null;
    this.dictaphoneHandler = null; // Referencia a tu DictaphoneHandler

    // Estado y Preferencias
    this.errors = [];
    this.isInitialized = false;
    this.configLoaded = false;
    this.userPreferences = { // Valores por defecto
      dictationLanguage: 'es-ES',
      enableDictaphone: true,
      enableOllama: true,
      preferredDictationStrategy: null, // null = auto
      ollamaConfig: {
        endpoint: 'http://localhost:11434',
        defaultModel: null, // Que OllamaService decida el default si es null
        requestTimeout: 120000 // Timeout para Ollama
      }
      // Añadir más preferencias según sea necesario
    };
    this.currentReport = null; // Puede guardar contexto del informe actual

    // Configurar handlers de errores internos
    this._setupInternalErrorHandlers();
  }

  _setupInternalErrorHandlers() {
    // Manejar errores específicos emitidos internamente si es necesario
    Object.values(ERROR_TYPES).forEach(type => {
      this.on(`error:${type}`, (error) => {
        // Solo loguear si no es un error que ya estamos manejando explícitamente
        if (!error._handled) {
            this.logger.debug(`Evento de error interno recibido (${type}): ${error.message}`);
        }
      });
    });
  }

  async initialize(mainWindow) {
    try {
      this.logger.info('Iniciando inicialización de RadiologistAppController...');
      if (this.isInitialized) { this.logger.warn('Controller ya inicializado.'); return true; }
      if (mainWindow && !this.mainWindow) this.mainWindow = mainWindow;
      if (!this.mainWindow) throw new Error("mainWindow no disponible para inicializar el controlador");

      // 1. Precheck (Lanza error crítico si falla)
      await ApplicationPrecheck.runFullCheck();

      // 2. Requirements Check
      const requirements = await SystemRequirementsChecker.runAllChecks({ ollamaEndpoint: this.userPreferences.ollamaConfig.endpoint });
      if (!requirements.meetsRequirements) { // Comprobar si hay issues críticos
        throw this._createError(ERROR_TYPES.REQUIREMENTS_ERROR, 'Requisitos críticos del sistema no cumplidos.', { critical: true, details: requirements.issues });
      }
      if (requirements.recommendations?.length > 0) { // Mostrar warnings si hay recomendaciones
         const recommendationsMsg = requirements.recommendations.join('\n');
         this.logger.warn(`Recomendaciones del sistema:\n${recommendationsMsg}`);
         dialog.showMessageBox(this.mainWindow, { type: 'warning', title: 'Requisitos del Sistema', message: 'Su sistema no cumple todos los requisitos recomendados.', detail: recommendationsMsg, buttons: ['Entendido'] }).catch(e => {}); // Ignorar error si diálogo falla
         this._handleError(this._createError(ERROR_TYPES.REQUIREMENTS_ERROR, 'Requisitos recomendados no cumplidos.', { critical: false, details: recommendationsMsg }));
      }

      // 3. Inicializar Servicios (en orden)
      // 3.1 Database (Crítico)
      try { this.dbManager = new DatabaseManager({ logger: this.logger }); await this.dbManager.initialize(); }
      catch(error) { throw this._createError(ERROR_TYPES.DATABASE_INIT_ERROR, `Error inicializando DB: ${error.message}`, { critical: true, nativeError: error }); }

      // 3.2 Cargar Preferencias (Errores no críticos, usa defaults)
      await this._loadUserPreferences();

      // 3.3 Dictaphone Handler (No crítico si falla)
      if (this.userPreferences.enableDictaphone) {
         try {
             this.dictaphoneHandler = new DictaphoneHandler({ logger: this.logger, dbManager: this.dbManager, maxReconnectAttempts: 5 /* Ejemplo */ });
             // await this.dictaphoneHandler.initialize(); // Si tu handler lo requiere
             this._setupDictaphoneListeners(); // Escuchar eventos del handler
             await this.dictaphoneHandler.findAndConnect(); // Intentar conectar al primer dispositivo compatible
             this.logger.info('DictaphoneHandler inicializado e intentando conectar.');
         } catch (error) { this._handleError(this._createError(ERROR_TYPES.DICTAPHONE_INIT_ERROR, `Fallo init dictáfono: ${error.message}`,{ critical: false, nativeError: error })); this.dictaphoneHandler = null; }
      } else { this.logger.info('DictaphoneHandler deshabilitado.'); }

      // 3.4 Speech Recognition Service (No crítico si hay fallback?)
      try {
          this.speechService = new SpeechRecognitionService({
              logger: this.logger, dbManager: this.dbManager, mainWindow: this.mainWindow,
              preferredStrategy: this.userPreferences.preferredDictationStrategy,
              language: this.userPreferences.dictationLanguage,
              dictaphoneHandler: this.dictaphoneHandler // Inyectar handler existente
          });
          await this.speechService.initialize(this.mainWindow);
          this._setupSpeechServiceListeners(); // Escuchar eventos consolidados del servicio
      } catch (error) { this._handleError(this._createError(ERROR_TYPES.SPEECH_INIT_ERROR, `Fallo init SR: ${error.message}`, { critical: false, nativeError: error })); this.speechService = null; }

      // 3.5 Term Replacement Service (Tu versión optimizada - No crítico)
      try {
        this.termReplacementService = new MedicalTermReplacementService(this.dbManager, { logger: this.logger /* Pasar otras opciones si las necesita */ });
        await this.termReplacementService.refreshCache(); // Cargar caché inicial
        this.logger.info('MedicalTermReplacementService (Optimized) inicializado.');
      } catch (error) { this._handleError(this._createError(ERROR_TYPES.INITIALIZATION, `Fallo init Terms: ${error.message}`, { critical: false, nativeError: error })); this.termReplacementService = null; }

      // 3.6 Ollama Service (No crítico)
      if (this.userPreferences.enableOllama) {
        try {
          this.ollamaService = new OllamaService({
            logger: this.logger,
            endpoint: this.userPreferences.ollamaConfig.endpoint,
            defaultModel: this.userPreferences.ollamaConfig.defaultModel,
            requestTimeout: this.userPreferences.ollamaConfig.requestTimeout || 120000
          });
          await this.ollamaService.initialize(this.dbManager);
          if (!this.ollamaService.isAvailable) this.logger.warn(`Ollama Service inicializado pero no disponible en ${this.ollamaService.endpoint}`);
        } catch (error) { this._handleError(this._createError(ERROR_TYPES.OLLAMA_INIT_ERROR, `Fallo init Ollama: ${error.message}`, { critical: false, nativeError: error })); this.ollamaService = null; }
      } else { this.logger.info('OllamaService deshabilitado.'); }

      // 4. Configurar eventos IPC
      this._setupIPCEvents();

      // 5. Inicialización Completa
      this.isInitialized = true; this.logger.info('RadiologistAppController inicializado correctamente'); return true;

    } catch (error) {
      this.logger.fatal('Error fatal durante inicialización Controller:', error);
      const structuredError = (error.type && error.critical) ? error : this._createError(error.type || ERROR_TYPES.INITIALIZATION, `Fatal Init Error: ${error.message}`, { critical: true, nativeError: error });
      this._handleError(structuredError); // Asegurar logueo
      throw structuredError; // Relanzar a main.js
    }
  }

  // --- Setup Listeners ---
   _setupSpeechServiceListeners() {
        if (!this.speechService) { this.logger.warn("Intento de configurar listeners de SpeechService sin servicio."); return; }
        this.speechService.on('dictationStarted', () => this._notifyRenderer('dictation-started'));
        this.speechService.on('dictationStopped', async (transcription) => {
            let result = { original: transcription, processed: transcription, replacementsMade: 0, replacementDetails: [] };
            if (this.termReplacementService && transcription) {
                try {
                    const processingResult = await this.termReplacementService.processText(transcription, this.currentReport?.specialty, this.currentReport?.modality);
                    result = { original: transcription, processed: processingResult.text || transcription, replacementsMade: processingResult.replacements?.length || 0, replacementDetails: processingResult.replacements };
                } catch (error) { this._handleError(this._createError(ERROR_TYPES.TERM_REPLACEMENT_ERROR, `Error procesando texto final: ${error.message}`, { critical: false, nativeError: error })); }
            }
            this._notifyRenderer('dictation-stopped', result);
        });
        this.speechService.on('transcriptionUpdate', (data) => this._notifyRenderer('transcription-update', data));
        this.speechService.on('dictationError', (error) => { this._notifyRenderer('dictation-error', { message: error?.message, type: error?.type, id: error?.id }); this._handleError(error); });
        this.speechService.on('needsUserSetup', (data) => this._notifyRenderer('needs-user-setup', data));
        this.speechService.on('metrics', (metricsData) => this.logger.debug('Métricas estrategia:', metricsData));
   }

   _setupDictaphoneListeners() {
        if (!this.dictaphoneHandler) return;
        this.dictaphoneHandler.on('dictaphoneConnected', (data) => this._notifyRenderer('dictaphone-connected', data));
        this.dictaphoneHandler.on('dictaphoneDisconnected', (data) => this._notifyRenderer('dictaphone-disconnected', data));
        this.dictaphoneHandler.on('dictaphoneAction', (action) => this.handleDictaphoneAction(action));
        this.dictaphoneHandler.on('dictaphoneError', (error) => this._notifyRenderer('dictaphone-error', { message: error?.message, type: error?.type, id: error?.id }));
        this.dictaphoneHandler.on('dictaphoneReconnecting', (data) => this._notifyRenderer('dictaphone-reconnecting', data));
        this.dictaphoneHandler.on('dictaphoneReconnectFailed', (data) => this._notifyRenderer('dictaphone-reconnect-failed', data));
        this.dictaphoneHandler.on('buttonLearningData', (data) => this._notifyRenderer('dictaphone-learning-data', data)); // Para UI aprendizaje
        this.dictaphoneHandler.on('learningModeStarted', () => this._notifyRenderer('dictaphone-learning-started'));
        this.dictaphoneHandler.on('learningModeStopped', (data) => this._notifyRenderer('dictaphone-learning-stopped', data));
   }

  // --- Manejo Acción Dictáfono ---
  handleDictaphoneAction(action) {
    if (!action) return; this.logger.debug(`Acción dictáfono: ${action}`);
    this._notifyRenderer('dictaphone-action', { action: action });
    try {
        switch (action) {
          case 'start_dictation': case 'record': if (this.speechService && !this.speechService.isListening) this.speechService.startListening().catch(e => this._handleDictationActionError('iniciar', e)); break;
          case 'stop_dictation': case 'stop': if (this.speechService && this.speechService.isListening) this.speechService.stopListening().catch(e => this._handleDictationActionError('detener', e)); break;
          case 'toggle_dictation': case 'play_pause': if (this.speechService) { if (this.speechService.isListening) this.speechService.stopListening().catch(e => this._handleDictationActionError('detener (toggle)', e)); else this.speechService.startListening().catch(e => this._handleDictationActionError('iniciar (toggle)', e)); } break;
          case 'new_report': case 'save_report': case 'improve_report': this._notifyRenderer(action.replace('_', '-') + '-request'); break;
          default: this._notifyRenderer('custom-dictaphone-action', { action }); break;
        }
    } catch (serviceError) { this._handleError(this._createError(ERROR_TYPES.SPEECH_UNAVAILABLE, `Servicio dictado no disponible para acción '${action}'`, {critical: false})); }
  }
  _handleDictationActionError(actionDesc, error) { this.logger.error(`Error al ${actionDesc} dictado desde dictáfono:`, error); this._handleError(this._createError(ERROR_TYPES.SPEECH_RECOGNITION, `Fallo al ${actionDesc} dictado: ${error.message}`, { critical: false, nativeError: error })); }

  // --- Configuración Handlers IPC ---
  _setupIPCEvents() {
    if (!ipcMain) { this.logger.error("ipcMain no disponible."); return; }
    const handle = async (channel, handler) => { try { return await handler(); } catch(e) { const err = this._handleError(this._createError(ERROR_TYPES.IPC_ERROR, `IPC ${channel}: ${e.message}`, {nativeError: e})); return { success: false, error: err.message }; } };
    const handleWithArgs = async (channel, handler, ...args) => { try { return await handler(...args); } catch(e) { const err = this._handleError(this._createError(ERROR_TYPES.IPC_ERROR, `IPC ${channel}: ${e.message}`, {nativeError: e})); return { success: false, error: err.message }; } };

    // Dictado
    ipcMain.handle('start-dictation', (e, options) => handleWithArgs('start-dictation', async (opts) => { if (!this.speechService) throw new Error('SR no disp.'); if (this.speechService.isListening) return { success: true }; await this.speechService.startListening(opts); return { success: true }; }, options));
    ipcMain.handle('stop-dictation', () => handle('stop-dictation', async () => { if (!this.speechService) throw new Error('SR no disp.'); if (!this.speechService.isListening) return { success: true, transcription: this.speechService.currentTranscription || '' }; const transcription = await this.speechService.stopListening(); return { success: true, transcription }; }));
    ipcMain.handle('get-dictation-status', () => ({ available: !!this.speechService, isListening: !!this.speechService?.isListening, strategy: this.speechService?.activeStrategy?.constructor.name || 'None' }));

    // Dictáfono
    ipcMain.handle('get-connected-dictaphones', () => this.dictaphoneHandler?.getConnectedDevices() || []);
    ipcMain.handle('set-active-dictaphone', async (_, devicePath) => handleWithArgs('set-active-dictaphone', async (path) => { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); const devInfo = await this.dictaphoneHandler.findAndConnect(path); return { success: true, device: devInfo }; }, devicePath));
    ipcMain.handle('get-dictaphone-info', () => { const dev = this.dictaphoneHandler?.getActiveDevice(); return { isConnected: !!dev, device: dev }; });
    ipcMain.handle('save-dictaphone-config', async (_, config) => handleWithArgs('save-dictaphone-config', async (cfg) => { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); if (!cfg || !this.dictaphoneHandler.dictaphoneConfig) throw new Error("Config inválida o no activa"); this.dictaphoneHandler.dictaphoneConfig.buttons = cfg.buttons || {}; /* Aquí podrías añadir más config */ this.dictaphoneHandler.dictaphoneConfig.modified = true; const saved = await this.dictaphoneHandler.saveConfig(); return { success: saved }; }, config));
    ipcMain.handle('get-default-dictaphone-mappings', (_, modelInfo) => ({ success: true, mappings: this.dictaphoneHandler?.getDefaultMappings(modelInfo?.modelName, modelInfo?.productId) || {} }));
    ipcMain.handle('start-dictaphone-learning', () => handle('start-learning', async () => { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); this.dictaphoneHandler.startLearningMode(); return { success: true }; }));
    ipcMain.handle('stop-dictaphone-learning', () => handle('stop-learning', async () => { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); this.dictaphoneHandler.stopLearningMode(); return { success: true }; }));
    ipcMain.handle('assign-dictaphone-button', (_, data) => handleWithArgs('assign-button', async (d) => { if (!this.dictaphoneHandler) throw new Error('Handler no disp.'); const assigned = this.dictaphoneHandler.assignLearnedButton(d.formattedData, d.action); return { success: assigned }; }, data));

    // Ollama
    ipcMain.handle('ollama-request', async (_, methodName, ...args) => await this._handleOllamaRequest(methodName, ...args));
    ipcMain.handle('update-ollama-config', async (_, config) => await this._updateOllamaConfig(config));
    ipcMain.handle('get-ollama-status', () => this.ollamaService ? this.ollamaService.getStatus() : { available: false, status: 'Disabled' });

    // Términos Médicos
    ipcMain.handle('process-medical-text', async (_, text, options) => handleWithArgs('process-text', async (t, o) => { if (!this.termReplacementService) throw new Error('Terms no disp.'); const result = await this.termReplacementService.processText(t, o?.specialty, o?.modality); return { success: true, data: result }; }, text, options));
    ipcMain.handle('add-medical-term', async (_, h, c, o) => handleWithArgs('add-term', async (...a) => { if (!this.termReplacementService) throw new Error('Terms no disp.'); const id = await this.termReplacementService.addOrUpdateTerm(...a); return { success: true, id }; }, h, c, o));
    ipcMain.handle('get-medical-term-suggestions', async (_, p, o) => handleWithArgs('get-term-sugg', async (...a) => { if (!this.termReplacementService) throw new Error('Terms no disp.'); const suggestions = await this.termReplacementService.getSuggestions(...a); return { success: true, suggestions }; }, p, o));

    // Configuración General
    ipcMain.handle('save-setting', async (_, key, value) => await this._saveSetting(key, value));
    ipcMain.handle('get-all-settings', async () => await this._getAllSettings());
    ipcMain.handle('get-setting', async (_, key) => handleWithArgs('get-setting', async (k) => ({ success: true, value: await this.dbManager?.getSetting(k) }), key));
    ipcMain.handle('reload-config', async () => handle('reload-config', async () => { this.logger.info("Recargando config..."); await this._loadUserPreferences(); this._notifyRenderer('config-reloaded'); return { success: true }; }));

    // Plantillas
    ipcMain.handle('get-templates', async () => handle('get-templates', async () => ({ success: true, templates: await this.dbManager?.getAllTemplates() || [] })));
    ipcMain.handle('save-template', async (_, data) => handleWithArgs('save-template', async (d) => ({ success: true, id: await this.dbManager?.saveTemplate(d) }), data));

    // Errores
    ipcMain.handle('get-error-log', async (_, errorId) => this._findErrorById(errorId));
    ipcMain.handle('get-recent-errors', async (_, count = 10) => this.errors.slice(-count));

    this.logger.info('Eventos IPC configurados.');
  }


  // --- Helpers Internos ---
  async _handleOllamaRequest(methodName, ...args) { try { if (!this.ollamaService) throw this._createError(ERROR_TYPES.OLLAMA_UNAVAILABLE, 'Ollama no disponible.'); if (typeof this.ollamaService[methodName] !== 'function') throw this._createError(ERROR_TYPES.OLLAMA_REQUEST_ERROR, `Método ${methodName} no válido.`); const result = await this.ollamaService[methodName](...args); return { success: true, data: result }; } catch (error) { const handledError = this._handleError(error.type ? error : this._createError(ERROR_TYPES.OLLAMA_REQUEST_ERROR, `Ollama ${methodName}: ${error.message}`, { nativeError: error })); return { success: false, error: handledError.message, errorType: handledError.type }; } }
  async _saveSetting(key, value) { try { if (!this.dbManager) throw new Error('DB no disp.'); await this.dbManager.saveSetting(key, value); if (key.startsWith('preference.')) this._updateLocalPreference(key.substring(11), value); this._notifyRenderer('config-changed', { key, value }); this.emit(`config-changed:${key}`, value); return { success: true }; } catch (e) { const err = this._handleError(this._createError(ERROR_TYPES.CONFIG_SAVE_ERROR, `Save setting ${key}: ${e.message}`, {nativeError: e})); return { success: false, error: err.message }; } }
  async _getAllSettings() { try { if (!this.dbManager) throw new Error('DB no disp.'); const settings = await this.dbManager.getAllSettings(); return { success: true, settings: settings || {} }; } catch (e) { const err = this._handleError(this._createError(ERROR_TYPES.CONFIG_LOAD_ERROR, `Get settings: ${e.message}`, {nativeError: e})); return { success: false, error: err.message, settings: {} }; } }
  async _updateOllamaConfig(config) { try { let needsCheck = false; if (this.ollamaService) { await this.ollamaService.updateConfig(config, this.dbManager); if(config.endpoint && config.endpoint !== this.userPreferences.ollamaConfig.endpoint) needsCheck=true; } else if (!this.userPreferences.enableOllama) throw new Error('Ollama deshabilitado'); else this.logger.warn('Guardando config Ollama sin servicio activo.'); /* Guardar prefs en DB */ if (config.endpoint !== undefined) await this._saveSetting('ollama.endpoint', config.endpoint); if (config.defaultModel !== undefined) await this._saveSetting('ollama.defaultModel', config.defaultModel); if (config.requestTimeout !== undefined) await this._saveSetting('ollama.requestTimeout', config.requestTimeout); await this._loadUserPreferences(); if (needsCheck && this.ollamaService) await this.ollamaService.checkAvailability(); return { success: true }; } catch (e) { const err = this._handleError(this._createError(ERROR_TYPES.CONFIGURATION, `Update Ollama config: ${e.message}`, {nativeError: e})); return { success: false, error: err.message }; } }
  async _loadUserPreferences() { try { this.logger.info('Cargando preferencias...'); if (!this.dbManager) throw new Error('DB no disp.'); const settings = await this.dbManager.getAllSettings(); if (settings) { for (const key in this.userPreferences) { const savedValue = settings[`preference.${key}`]; if (savedValue !== undefined) this._updateLocalPreference(key, savedValue); } /* Cargar ollamaConfig anidado */ const savedOllama = settings['preference.ollamaConfig']; if(typeof savedOllama === 'object' && savedOllama !== null) this.userPreferences.ollamaConfig = {...this.userPreferences.ollamaConfig, ...savedOllama}; else { /* cargar claves individuales si no */ } } else { this.logger.warn('No se cargaron settings de BD.'); } this.configLoaded = true; this.logger.info('Preferencias cargadas:', this.userPreferences); return true; } catch (e) { this.logger.error('Error cargando prefs:', e); this._handleError(this._createError(ERROR_TYPES.CONFIG_LOAD_ERROR, `Error cargando prefs: ${e.message}`, { critical: false, nativeError: e })); this.configLoaded = false; return false; } }
  _updateLocalPreference(key, value) { /* ... (igual que antes) ... */ }
  _notifyRenderer(channel, data = {}) { if (this.mainWindow?.webContents && !this.mainWindow.webContents.isDestroyed()) { try { this.mainWindow.webContents.send(channel, data); } catch (e) { this.logger.error(`Error send IPC (${channel}): ${e.message}`); } } else { /* log warn */ } }
  _createError(type, message, details = {}) { /* ... (igual que antes) ... */ }
  _handleError(error) { /* ... (igual que antes) ... */ error._handled = true; return error; } // Marcar como manejado
  _findErrorById(errorId) { return this.errors.find(error => error.id === errorId) || null; }

  // --- Limpieza ---
  async cleanup() {
      this.logger.info('Limpiando RadiologistAppController...');
      const cleanupService = async (serviceName, serviceInstance) => {
          if (serviceInstance) {
              try { await serviceInstance.cleanup(); this.logger.debug(`${serviceName} limpiado.`); }
              catch (e) { this.logger.error(`Error limpiando ${serviceName}:`, e); }
          }
      };
      await cleanupService('OllamaService', this.ollamaService);
      await cleanupService('MedicalTermReplacementService', this.termReplacementService);
      await cleanupService('SpeechRecognitionService', this.speechService); // Limpia su propio handler
      // Limpiar handler solo si no fue limpiado por SpeechService
      if (this.dictaphoneHandler && !this.speechService?.dictaphoneHandler) {
          await cleanupService('DictaphoneHandler', this.dictaphoneHandler);
      }
      await cleanupService('DatabaseManager', this.dbManager);

      // Remover listeners IPC (simplificado, removeAllHandlers puede ser peligroso si otros registran)
      // Mejor no remover nada aquí o ser muy específico, ya que main.js puede tener handlers
      this.logger.warn("Limpieza de handlers IPC omitida para evitar remover handlers globales.");

      this.removeAllListeners(); // Limpiar listeners propios
      this.isInitialized = false; this.configLoaded = false; this.errors = [];
      this.logger.info('RadiologistAppController limpiado.');
  }
}

module.exports = RadiologistAppController;