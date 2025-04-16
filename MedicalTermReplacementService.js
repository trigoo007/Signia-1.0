const { EventEmitter } = require('events');
const logger = require('../utils/logger');
const os = require('os'); // Para _checkMemoryUsage
const { performance } = require('perf_hooks'); // Para medir tiempo

class MedicalTermReplacementService extends EventEmitter {
  constructor(dbManager, options = {}) { // Aceptar opciones
    super();
    if (!dbManager) throw new Error("MedicalTermReplacementService requiere dbManager.");
    this.dbManager = dbManager;
    this.logger = options.logger || logger;

    // Configuración de caché y rendimiento
    this.cacheLimit = options.cacheLimit || 1000;
    this.cacheUpdateInterval = options.cacheUpdateInterval || 10 * 60 * 1000; // 10 min
    this.levenshteinThreshold = options.levenshteinThreshold || 2; // Distancia máxima para fuzzy match
    this.maxContextLength = options.maxContextLength || 100; // Palabras en memoria contextual
    this.maxReplacementHistory = options.maxReplacementHistory || 100;
    this.memoryWarningThreshold = options.memoryWarningThreshold || 0.8; // 80%
    this.batchUpdateThreshold = options.batchUpdateThreshold || 10;
    this.batchUpdateInterval = options.batchUpdateInterval || 60 * 1000; // 1 min

    // Estado interno
    this.cachedTerms = []; // Array de objetos {id, heard_term, correct_term, frequency, ...}
    this.contextualMemory = []; // Array de palabras recientes
    this.replacementHistory = []; // Array de objetos de reemplazo detallados
    this.cacheLastUpdated = 0;
    this.hasTriggeredWarning = false;
    this._levenMatrix = null; // Matriz reutilizable para Levenshtein

    // Índices en memoria
    this.termIndexByLength = {};
    this.termIndexByFirstChar = {};
    this.frequentTermsCache = {}; // Map de { lower_heard_term: termObject }

    // Batch de actualizaciones de frecuencia
    this.frequencyUpdateBatch = {}; // Map de { termId: incrementCount }
    this.lastBatchUpdate = Date.now();

    // Intervalos
    this.memoryMonitorInterval = null;
    this.dbUpdateInterval = null;

    // Inicializar monitores y planificación
    this._setupMemoryMonitor();
    this._scheduleDatabaseUpdates();
    this.logger.info("MedicalTermReplacementService (Optimized) instanciado.");
    // La carga inicial de caché se hace en refreshCache(), llamada por el Controller
  }

  _setupMemoryMonitor() {
    if (this.memoryMonitorInterval) clearInterval(this.memoryMonitorInterval);
    this.memoryMonitorInterval = setInterval(() => {
      this._checkMemoryUsage();
    }, 5 * 60 * 1000); // Cada 5 minutos
  }

  _scheduleDatabaseUpdates() {
    if (this.dbUpdateInterval) clearInterval(this.dbUpdateInterval);
    this.dbUpdateInterval = setInterval(() => {
      this._flushFrequencyBatch().catch(error => {
        this.logger.error('Error en actualización programada de frecuencias', error);
      });
    }, this.batchUpdateInterval);
  }

  _checkMemoryUsage() {
    try {
      const memoryUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
      const rssMemoryMB = Math.round(memoryUsage.rss / 1024 / 1024);
      this.logger.debug(`Uso Memoria (Terms): Heap=${heapUsedMB}MB/${heapTotalMB}MB, RSS=${rssMemoryMB}MB`);
      const heapUsagePercentage = memoryUsage.heapTotal > 0 ? memoryUsage.heapUsed / memoryUsage.heapTotal : 0;
      if (heapUsagePercentage > 0.85 && this.cachedTerms.length > this.cacheLimit * 0.5) {
        this.logger.warn(`Uso Heap alto (${Math.round(heapUsagePercentage*100)}%). Reduciendo caché...`);
        this._reduceCacheSize(Math.floor(this.cacheLimit * 0.5));
        this._flushFrequencyBatch().catch(e => this.logger.error('Error flush post-reducción caché', e));
      } else if (rssMemoryMB > 500) { // Ajustar umbral RSS si es necesario
        this.logger.warn(`Uso RSS alto (${rssMemoryMB}MB). Limpiando caché completa.`);
        this.clearCache();
        if (global.gc) { try { global.gc(); this.logger.debug("GC solicitado."); } catch (e) { this.logger.warn("Error solicitando GC:", e);} }
      }
    } catch (error) { this.logger.error('Error comprobando memoria:', error); }
  }

  _reduceCacheSize(newLimit) {
    if (this.cachedTerms.length <= newLimit) return;
    this.logger.info(`Reduciendo caché de ${this.cachedTerms.length} a <= ${newLimit} términos...`);
    this.cachedTerms.sort((a, b) => (b.frequency || 0) - (a.frequency || 0)); // Ordenar por frecuencia
    const oldSize = this.cachedTerms.length;
    this.cachedTerms = this.cachedTerms.slice(0, newLimit); // Mantener los más frecuentes
    this._rebuildTermIndices(); // Reconstruir índices
    this.logger.info(`Caché reducida de ${oldSize} a ${this.cachedTerms.length}.`);
  }

  _rebuildTermIndices() {
    const startTime = performance.now();
    this.termIndexByLength = {}; this.termIndexByFirstChar = {}; this.frequentTermsCache = {};
    for (const term of this.cachedTerms) {
      const heardTermLower = term.heard_term.toLowerCase();
      const termLength = heardTermLower.length;
      if (!this.termIndexByLength[termLength]) this.termIndexByLength[termLength] = [];
      this.termIndexByLength[termLength].push(term);
      const firstChar = heardTermLower.charAt(0);
      if (!this.termIndexByFirstChar[firstChar]) this.termIndexByFirstChar[firstChar] = [];
      this.termIndexByFirstChar[firstChar].push(term);
      if (term.frequency && term.frequency > 5) { // Umbral para caché frecuente
          this.frequentTermsCache[heardTermLower] = term;
          const variants = typeof term.variants === 'string' ? JSON.parse(term.variants || '[]') : (term.variants || []);
          if (Array.isArray(variants)) {
              for (const variant of variants) if (variant) this.frequentTermsCache[variant.toLowerCase()] = term;
          }
      }
    }
    const duration = (performance.now() - startTime).toFixed(2);
    this.logger.debug(`Índices reconstruidos (${duration}ms): ${Object.keys(this.frequentTermsCache).length} frecuentes.`);
  }

  async refreshCache() {
    const now = Date.now();
    if (this.cachedTerms.length > 0 && now - this.cacheLastUpdated < this.cacheUpdateInterval) return; // Evitar refrescos muy seguidos
    this.logger.info(`Actualizando caché de términos...`);
    const oldCacheSize = this.cachedTerms.length;
    try {
      await this._flushFrequencyBatch(); // Guardar frecuencias pendientes primero
      if (!this.dbManager?.getMostFrequentTerms) { this.logger.warn("dbManager.getMostFrequentTerms no disponible."); return; }
      const newTerms = await this.dbManager.getMostFrequentTerms(this.cacheLimit);
      this.cachedTerms = newTerms || [];
      this.cacheLastUpdated = now;
      this._rebuildTermIndices();
      if (this.cachedTerms.length >= this.cacheLimit * this.memoryWarningThreshold && !this.hasTriggeredWarning) { this.logger.warn(`Caché alcanzando límite (${this.cachedTerms.length}/${this.cacheLimit}).`); this.hasTriggeredWarning = true; }
      else if (this.cachedTerms.length < this.cacheLimit * this.memoryWarningThreshold) { this.hasTriggeredWarning = false; }
      this._checkMemoryUsage(); // Verificar memoria después de cargar
      this.logger.info(`Caché actualizada: ${this.cachedTerms.length} términos (antes: ${oldCacheSize})`);
    } catch (error) {
      this.logger.error('Error actualizando caché términos:', error);
      if (oldCacheSize === 0) { this.cachedTerms = []; this._rebuildTermIndices(); } // Vaciar si falla y no había nada antes
    }
  }

  // --- Métodos Públicos ---
  async processText(text, specialty = null, modality = null) {
    const startTime = performance.now();
    try {
      if (!text || text.trim() === '') return { text, replacements: [] };
      await this.refreshCache(); // Asegurar caché razonablemente fresca
      if (text.length > 15000) { // Aumentar límite para procesar en bloques
        this.logger.warn(`Procesando texto largo (${text.length} chars) en bloques...`);
        return await this._processLargeText(text, specialty, modality, 10000); // Bloques más grandes
      }
      const sentences = this._splitIntoSentences(text);
      let processedText = ''; const allReplacements = []; let currentOffset = 0;
      for (const sentence of sentences) {
        const { text: processedSentence, replacements: sentenceReplacements } = await this._processSentence(sentence, specialty, modality);
        processedText += processedSentence;
        sentenceReplacements.forEach(rep => { if (rep.textIndices) { rep.textIndices.start += currentOffset; rep.textIndices.end += currentOffset; } rep.originalFullTextOffset = currentOffset; });
        allReplacements.push(...sentenceReplacements);
        currentOffset += sentence.length; // Incrementar offset por longitud ORIGINAL
      }
      this._recordReplacements(allReplacements);
      if (allReplacements.length > 5) setTimeout(() => this._flushFrequencyBatch().catch(e => this.logger.error('Error flush diferido', e)), 1500);
      const duration = (performance.now() - startTime).toFixed(2);
      if (allReplacements.length > 0) this.logger.info(`Texto procesado (${duration}ms), ${allReplacements.length} reemplazos.`);
      return { text: processedText, replacements: allReplacements };
    } catch (error) { this.logger.error('Error procesando texto:', error); return { text, replacements: [] }; }
  }

  async addOrUpdateTerm(heardTerm, correctTerm, options = {}) {
     if (!heardTerm || !correctTerm) { this.logger.error("addOrUpdateTerm requiere heardTerm y correctTerm."); return null; }
     if (!this.dbManager?.addOrUpdateMedicalTerm) { this.logger.error("dbManager.addOrUpdateMedicalTerm no disponible."); return null; }
     try {
         const { specialty = null, modality = null, variants = [], contextWords = [] } = options;
         const termId = await this.dbManager.addOrUpdateMedicalTerm(heardTerm, correctTerm, specialty, modality, variants, contextWords);
         await this.refreshCache(); // Forzar refresco para que esté disponible
         return termId;
     } catch(error) { this.logger.error("Error añadiendo/actualizando término:", error); return null; }
  }

   async getSuggestions(partialTerm, options = {}) { /* ... (implementación igual que antes) ... */ }
   undoLastReplacement(text) { /* ... (implementación igual que antes) ... */ }
   clearCache() { /* ... (implementación igual que antes) ... */ }
   async cleanup() { /* ... (implementación igual que antes) ... */ }

  // --- Métodos Privados / Protegidos ---
  async _processSentence(sentence, specialty, modality) { /* ... (implementación igual que antes) ... */ }
  async _findMatchingTermEfficient(text, specialty = null, modality = null) { /* ... (implementación igual que antes) ... */ }
  _addTermToCache(term) { /* ... (implementación igual que antes) ... */ }
  _matchesFilters(term, specialty, modality) { /* ... (implementación igual que antes) ... */ }
  _levenshteinDistance(a, b) { /* ... (implementación igual que antes) ... */ }
  _incrementTermFrequencyBatch(termId) { /* ... (implementación igual que antes) ... */ }
  async _flushFrequencyBatch() { /* ... (implementación igual que antes) ... */ }
  escapeRegExp(string) { /* ... (implementación igual que antes) ... */ }
  _recordReplacements(replacements) { /* ... (implementación igual que antes) ... */ }
  async _processLargeText(text, specialty, modality, blockSize) { /* ... (implementación igual que antes) ... */ }
  _splitIntoSentences(text) { /* ... (implementación igual que antes) ... */ }
  _updateContextualMemory(text) { /* ... (implementación igual que antes) ... */ }
  _calculateContextualScore(term, context) { /* ... (implementación igual que antes) ... */ }
}
module.exports = MedicalTermReplacementService;