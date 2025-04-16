const { EventEmitter } = require('events');
const axios = require('axios');
const logger = require('../utils/logger');
const ERROR_TYPES = require('../utils/error-types');

class OllamaService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.endpoint = options.endpoint || 'http://localhost:11434';
    this.defaultModel = options.defaultModel || null;
    this.requestTimeout = options.requestTimeout || 120000; // 120s
    this.isInitialized = false;
    this.isAvailable = false;
    this.availableModels = [];
    this.currentAbortController = null; // Usar AbortController nativo
  }

  async initialize(dbManager = null) {
    if (this.isInitialized) return;
    this.logger.info(`Inicializando OllamaService (Endpoint: ${this.endpoint})...`);
    if (dbManager) {
        try {
            const savedEndpoint = await dbManager.getSetting('ollama.endpoint');
            if (savedEndpoint) this.endpoint = savedEndpoint;
            const savedModel = await dbManager.getSetting('ollama.defaultModel');
            if (savedModel) this.defaultModel = savedModel;
            const savedTimeout = await dbManager.getSetting('ollama.requestTimeout');
            if (savedTimeout) this.requestTimeout = parseInt(savedTimeout, 10) || this.requestTimeout;
            this.logger.debug(`Config Ollama cargada: EP=${this.endpoint}, Model=${this.defaultModel}, Timeout=${this.requestTimeout}`);
        } catch (e) { this.logger.warn("No se pudo cargar config Ollama de BD:", e); }
    }
    await this.checkAvailability();
    this.isInitialized = true;
    this.logger.info(`OllamaService inicializado. Disponible: ${this.isAvailable}`);
  }

  // --- Métodos de la API ---

  async checkAvailability() {
    this.logger.debug(`Verificando Ollama en ${this.endpoint}...`);
    let wasAvailable = this.isAvailable;
    try {
      const response = await axios.get(`${this._getBaseUrl()}/api/tags`, { timeout: 5000 });
      if (response.status === 200 && response.data?.models && Array.isArray(response.data.models)) {
        this.isAvailable = true;
        this.availableModels = response.data.models.map(m => ({ name: m.name, modified_at: m.modified_at, size: m.size }));
        if (!wasAvailable) { // Emitir solo si cambia estado a disponible
            this.logger.info(`Ollama disponible. ${this.availableModels.length} modelos.`);
            this.emit('statusChanged', { available: true, models: this.availableModels.length });
        }
        return true;
      } else { throw new Error(`Respuesta inesperada (Status: ${response.status})`); }
    } catch (error) {
      this.isAvailable = false; this.availableModels = [];
      const message = this._parseConnectionError(error, this.endpoint);
      if (wasAvailable) { // Emitir solo si cambia estado a no disponible
          this.logger.warn(`Ollama NO disponible: ${message}`);
          this.emit('statusChanged', { available: false, error: message });
      }
      return false;
    }
  }

  async listModels(forceRefresh = false) {
    if (!this.isAvailable && !forceRefresh) return []; // No disponible y no forzar
    if (!forceRefresh && this.availableModels.length > 0) return [...this.availableModels]; // Devolver caché
    await this.checkAvailability(); // Forzar re-chequeo
    return [...this.availableModels];
  }

  // Generación de texto (no streaming)
  async generate(prompt, model = null, options = {}) {
     if (!this.isAvailable) throw this._createError(ERROR_TYPES.OLLAMA_UNAVAILABLE, 'Ollama no disponible.');
     const targetModel = model || this.defaultModel;
     if (!targetModel) throw this._createError(ERROR_TYPES.OLLAMA_MODEL_ERROR, 'Modelo Ollama no especificado.');
     const url = `${this._getBaseUrl()}/api/generate`;
     const payload = { model: targetModel, prompt, stream: false, ...options }; // stream: false
     this.logger.info(`Solicitando generación a Ollama (${targetModel})...`);
     this.emit('busy', { operation: 'generate', model: targetModel });
     this.currentAbortController = new AbortController();
     try {
         const response = await axios.post(url, payload, { timeout: this.requestTimeout, signal: this.currentAbortController.signal });
         this.logger.info(`Generación completada (${targetModel}).`);
         // Devuelve el objeto completo de la respuesta
         // Ejemplo: { model, created_at, response, done, context, total_duration, ... }
         return response.data;
     } catch (error) { throw this._handleApiError(error, 'generación'); }
     finally { this.currentAbortController = null; this.emit('idle', { operation: 'generate' }); }
  }

  // Chat (no streaming)
  async chat(messages, model = null, options = {}) {
     if (!this.isAvailable) throw this._createError(ERROR_TYPES.OLLAMA_UNAVAILABLE, 'Ollama no disponible.');
     const targetModel = model || this.defaultModel;
     if (!targetModel) throw this._createError(ERROR_TYPES.OLLAMA_MODEL_ERROR, 'Modelo Ollama no especificado.');
     if (!Array.isArray(messages) || messages.length === 0) throw this._createError(ERROR_TYPES.OLLAMA_REQUEST_ERROR, 'Mensajes inválidos.');
     const url = `${this._getBaseUrl()}/api/chat`;
     const payload = { model: targetModel, messages, stream: false, ...options }; // stream: false
     this.logger.info(`Solicitando chat a Ollama (${targetModel})...`);
     this.emit('busy', { operation: 'chat', model: targetModel });
     this.currentAbortController = new AbortController();
     try {
         const response = await axios.post(url, payload, { timeout: this.requestTimeout, signal: this.currentAbortController.signal });
         this.logger.info(`Chat completado (${targetModel}).`);
          // Devuelve el objeto completo de la respuesta
          // Ejemplo: { model, created_at, message: { role, content }, done, total_duration, ... }
         return response.data;
     } catch (error) { throw this._handleApiError(error, 'chat'); }
     finally { this.currentAbortController = null; this.emit('idle', { operation: 'chat' }); }
  }

  // Descargar modelo (streaming)
  async pullModel(modelName, insecure = false) {
     if (!this.isAvailable) throw this._createError(ERROR_TYPES.OLLAMA_UNAVAILABLE, 'Ollama no disponible.');
     if (!modelName) throw this._createError(ERROR_TYPES.OLLAMA_REQUEST_ERROR, 'Nombre modelo requerido.');
     const url = `${this._getBaseUrl()}/api/pull`;
     const payload = { name: modelName, insecure, stream: true }; // stream: true es necesario
     this.logger.info(`Iniciando descarga modelo: ${modelName}`);
     this.emit('busy', { operation: 'pull', model: modelName });
     this.emit('pullProgress', { model: modelName, status: 'Iniciando descarga...' }); // Estado inicial
     return new Promise((resolve, reject) => {
         axios.post(url, payload, { responseType: 'stream', timeout: 0 }) // Sin timeout
             .then(response => {
                 let finalStatus = {}; let lastPercent = -1; let buffer = '';
                 response.data.on('data', chunk => {
                     buffer += chunk.toString();
                     // Procesar líneas JSON completas en el buffer
                     let newlineIndex;
                     while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.substring(0, newlineIndex).trim();
                        buffer = buffer.substring(newlineIndex + 1);
                        if (!line) continue; // Ignorar líneas vacías
                        try {
                            const statusUpdate = JSON.parse(line);
                            finalStatus = statusUpdate; // Guardar último estado conocido
                            const percent = statusUpdate.percent;
                            // Emitir progreso con menos frecuencia (ej. cada 5% o estados clave)
                            if (percent !== undefined && Math.floor(percent / 5) !== Math.floor(lastPercent / 5)) {
                                this.emit('pullProgress', { model: modelName, ...statusUpdate });
                                lastPercent = percent;
                            } else if (statusUpdate.status && !statusUpdate.percent && statusUpdate.status !== finalStatus.status) {
                                this.emit('pullProgress', { model: modelName, ...statusUpdate }); // Emitir cambios de estado
                            }
                        } catch (e) { this.logger.warn(`Error parseando chunk pull JSON: ${e.message}`, line); }
                     }
                 });
                 response.data.on('end', () => {
                     this.logger.info(`Descarga ${modelName} completada.`);
                     this.emit('idle', { operation: 'pull', success: true });
                     this.emit('pullProgress', { model: modelName, status: 'Descarga completa', completed: true, percent: 100 });
                     this.listModels(true).catch(e => this.logger.warn("Error refrescando modelos post-pull:", e));
                     resolve(finalStatus); // Resolver con el último mensaje de estado
                 });
                 response.data.on('error', err => {
                     this.logger.error(`Error stream descarga ${modelName}: ${err.message}`);
                     this.emit('idle', { operation: 'pull', success: false });
                     reject(this._handleApiError(err, `descarga ${modelName}`));
                 });
             })
             .catch(error => { // Error inicial de conexión
                 this.emit('idle', { operation: 'pull', success: false });
                 reject(this._handleApiError(error, `descarga ${modelName}`));
             });
     });
  }

   // Función ejemplo para mejorar informe
   async improveReport(text, specialty = null) {
        // Seleccionar un modelo adecuado. Podría ser configurable.
        const modelToUse = this.defaultModel || 'llama3'; // O 'mistral', 'gemma', etc.
        // Crear un prompt específico para la tarea de mejora de informes radiológicos
        const prompt = `Eres un asistente experto en radiología. Revisa el siguiente informe de ${specialty || 'radiología general'} y mejóralo significativamente: corrige errores gramaticales y de puntuación, reemplaza terminología vaga o incorrecta por términos médicos precisos y estándar, asegura una estructura clara y profesional (ej. Técnica, Hallazgos, Impresión Diagnóstica), y mejora la fluidez general. NO añadas información clínica nueva ni interpretes imágenes que no se describen. Mantén el significado clínico original.

Informe Original:
"${text}"

Informe Mejorado:`;

        this.logger.info(`Solicitando mejora de informe con modelo ${modelToUse}`);
        try {
            // Reutilizar el método 'generate'
            const result = await this.generate(prompt, modelToUse);
            // Devolver el objeto completo, el Controller se encargará de extraer 'response'
            return result;
        } catch (error) {
             this.logger.error(`Error al mejorar informe con Ollama: ${error.message}`);
             throw error; // Relanzar para que _handleOllamaRequest lo capture
        }
   }

  // Cancelar petición actual (generate o chat)
  cancelCurrentRequest() {
    if (this.currentAbortController) {
        this.logger.warn("Cancelando petición Ollama en curso...");
        this.currentAbortController.abort();
        this.currentAbortController = null;
        this.emit('idle', { operation: 'cancelled' });
        return true;
    }
    this.logger.debug("No hay petición Ollama activa para cancelar.");
    return false;
  }

  // --- Métodos de Configuración y Estado ---
  getStatus() {
      return {
          available: this.isAvailable,
          endpoint: this.endpoint,
          defaultModel: this.defaultModel,
          availableModels: this.availableModels.length,
          isBusy: !!this.currentAbortController // True si hay una petición cancelable en curso
      };
  }

  async updateConfig(newConfig, dbManager = null) {
      let configChanged = false;
      let needsAvailabilityCheck = false;

      if (newConfig.endpoint !== undefined && newConfig.endpoint !== this.endpoint) {
          this.endpoint = newConfig.endpoint; configChanged = true; needsAvailabilityCheck = true;
          if (dbManager) await dbManager.saveSetting('ollama.endpoint', this.endpoint).catch(e => this.logger.error("Error guardando endpoint Ollama", e));
      }
      if (newConfig.defaultModel !== undefined && newConfig.defaultModel !== this.defaultModel) {
          this.defaultModel = newConfig.defaultModel || null; configChanged = true;
          if (dbManager) await dbManager.saveSetting('ollama.defaultModel', this.defaultModel).catch(e => this.logger.error("Error guardando modelo Ollama", e));
      }
      if (newConfig.requestTimeout !== undefined && newConfig.requestTimeout !== this.requestTimeout) {
           this.requestTimeout = parseInt(newConfig.requestTimeout, 10) || this.requestTimeout; configChanged = true;
           if (dbManager) await dbManager.saveSetting('ollama.requestTimeout', this.requestTimeout).catch(e => this.logger.error("Error guardando timeout Ollama", e));
       }

       if (needsAvailabilityCheck) await this.checkAvailability(); // Re-verificar disponibilidad

       if (configChanged) this.logger.info(`Config Ollama actualizada: EP=${this.endpoint}, Model=${this.defaultModel}, Timeout=${this.requestTimeout}`);
      return configChanged; // Devolver si algo cambió
  }

  // --- Helpers Internos ---
  _getBaseUrl() { return this.endpoint.replace(/\/$/, ''); }

  _parseConnectionError(error, url) {
    if (error.code === 'ECONNREFUSED') return `No se pudo conectar a ${url}. ¿Ollama está en ejecución?`;
    if (error.code === 'ECONNABORTED' || error.message.toLowerCase().includes('timeout')) return `Timeout esperando respuesta de ${url}.`;
    if (error.response) return `Error API Ollama (${error.config?.url}): ${error.response.status} ${error.response.statusText}.`;
    return `Error red/configuración: ${error.message}`;
  }

  _handleApiError(error, operation = 'operación') {
       if (error.name === 'AbortError' || axios.isCancel?.(error)) { // Chequear cancelación primero
            this.logger.warn(`Solicitud Ollama (${operation}) cancelada.`);
            return this._createError(ERROR_TYPES.OLLAMA_REQUEST_ERROR, 'Solicitud cancelada', { isCancellation: true });
       }
       const ollamaErrorMsg = error.response?.data?.error;
       const httpStatus = error.response?.status;
       let message = `Error durante ${operation} con Ollama`;
       let type = ERROR_TYPES.OLLAMA_REQUEST_ERROR;
       if (ollamaErrorMsg) {
           message += `: ${ollamaErrorMsg}`;
           if (ollamaErrorMsg.includes('model') && ollamaErrorMsg.includes('not found')) type = ERROR_TYPES.OLLAMA_MODEL_ERROR;
       } else if (httpStatus) { message += ` (HTTP ${httpStatus})`; }
       else { message += `: ${this._parseConnectionError(error, this.endpoint)}`; type = ERROR_TYPES.OLLAMA_CONNECTION_ERROR; }
       this.logger.error(message, error);
       return this._createError(type, message, { nativeError: error, httpStatus });
  }

  _createError(type, message, details = {}) {
    const error = new Error(message); error.type = type || ERROR_TYPES.UNKNOWN; error.timestamp = Date.now();
    error.id = details.id || `${error.type}_${Date.now()}`; error.critical = details.critical === true; error.details = details.details || {};
    if(details.nativeError) { error.details.nativeError = details.nativeError; if (!error.stack && details.nativeError instanceof Error) error.stack = details.nativeError.stack; }
    if (details.httpStatus) error.details.httpStatus = details.httpStatus; if (details.isCancellation) error.isCancellation = true;
    return error;
  }

  cleanup() {
    this.logger.info('Limpiando OllamaService...');
    this.cancelCurrentRequest(); // Cancelar petición activa
    this.removeAllListeners();
    this.isInitialized = false; this.isAvailable = false; this.availableModels = [];
    this.logger.info('OllamaService limpiado.');
  }
}

module.exports = OllamaService;