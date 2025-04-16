/**
 * renderer.js - Lógica UI para Signia
 */

// Clase principal que encapsula la lógica de la UI
class RadiologyApp {
    constructor() {
      // --- Referencias a Elementos UI ---
      this.editor = document.getElementById('editor');
      this.startDictationBtn = document.getElementById('start-dictation');
      this.stopDictationBtn = document.getElementById('stop-dictation');
      this.clearTextBtn = document.getElementById('clear-text');
      this.newReportBtn = document.getElementById('new-report');
      this.saveReportBtn = document.getElementById('save-report');
      this.improveReportBtn = document.getElementById('improve-report');
      this.statusMessage = document.getElementById('status-message');
      this.wordCount = document.getElementById('word-count');
      this.dictationStatus = document.getElementById('dictation-status');
      this.dictaphoneStatus = document.getElementById('dictaphone-status');
      this.ollamaStatus = document.getElementById('ollama-status');
      this.dictaphoneInfo = document.getElementById('dictaphone-info');
      this.refreshDictaphoneBtn = document.getElementById('refresh-dictaphone');
      this.notification = document.getElementById('notification');
      this.templatesList = document.getElementById('templates-list');
      // Añadir más refs si son necesarias (ej. botón configuración)
  
      // --- Estado de la Aplicación ---
      this.isDictating = false;
      this.currentReport = { id: null, title: 'Nuevo Informe', content: '', specialty: 'General', modality: null, modified: false };
      this.dictaphoneConnected = false;
      this.ollamaAvailable = false;
      this.appSettings = {}; // Se carga desde el main process
      this.editorUpdateTimeout = null; // Para debounce de word count
      this.templates = []; // Caché de plantillas
      this.webSpeechRecognition = null; // Instancia de Web Speech API
      this.webSpeechFinalTranscript = ''; // Acumulador para Web Speech
      this.notificationTimeout = null; // ID del timeout de notificación
  
      // --- Bindings para Handlers de Eventos IPC (asegura el 'this') ---
      this._handleDictationStarted = this._handleDictationStarted.bind(this);
      this._handleDictationStopped = this._handleDictationStopped.bind(this);
      this._handleTranscriptionUpdate = this._handleTranscriptionUpdate.bind(this);
      this._handleDictaphoneConnected = this._handleDictaphoneConnected.bind(this);
      this._handleDictaphoneDisconnected = this._handleDictaphoneDisconnected.bind(this);
      this._handleDictaphoneAction = this._handleDictaphoneAction.bind(this);
      this._handleDictationError = this._handleDictationError.bind(this);
      this._handleDictaphoneError = this._handleDictaphoneError.bind(this);
      this._handleAppError = this._handleAppError.bind(this);
      this._handleConfigChanged = this._handleConfigChanged.bind(this);
      this._handleInitializationWarning = this._handleInitializationWarning.bind(this);
      this._handleNeedsUserSetup = this._handleNeedsUserSetup.bind(this);
      this._handleDictaphoneReconnecting = this._handleDictaphoneReconnecting.bind(this);
      this._handleDictaphoneReconnectFailed = this._handleDictaphoneReconnectFailed.bind(this);
      this._handleOllamaStatusChanged = this._handleOllamaStatusChanged.bind(this);
      this._handleDictaphoneLearningData = this._handleDictaphoneLearningData.bind(this);
      this._handleDictaphoneLearningStarted = this._handleDictaphoneLearningStarted.bind(this);
      this._handleDictaphoneLearningStopped = this._handleDictaphoneLearningStopped.bind(this);
  
    }
  
    /**
     * Inicializa la aplicación: configura listeners y carga estado inicial.
     */
    async initialize() {
      this.updateStatusMessage('Inicializando Signia...', 'info');
      // Verificar si la API del preload existe (esencial)
      if (!window.api) {
          this.updateStatusMessage('Error Crítico: Fallo de comunicación interna (preload).', 'error');
          this.showNotification('Error fatal: Reinicie la aplicación o contacte soporte.', 'error', 10000);
          // Deshabilitar toda interacción
          document.querySelectorAll('button, textarea').forEach(el => el.disabled = true);
          return;
      }
      try {
        this.setupEventListeners();       // Listeners de botones, editor, etc.
        this.initializeWebSpeechHandling(); // Configurar WebSpeech localmente
        this.setupIPCListeners();         // Suscribirse a eventos del main process
        await this.checkServicesStatus(); // Verificar estado inicial de servicios
        await this.loadSettings();        // Cargar configuración de usuario
        await this.loadTemplates();       // Cargar plantillas
        this.setupEditor();               // Configurar editor
  
        this.updateStatusMessage('Aplicación lista.', 'info');
        this.showNotification('Signia iniciada correctamente', 'success');
      } catch (error) {
        console.error('Error inicializando UI:', error);
        this.updateStatusMessage(`Error inicialización UI: ${error.message}`, 'error');
        this.showNotification(`Error inicialización UI: ${error.message}`, 'error');
      }
    }
  
    /**
     * Configura listeners para elementos UI (botones, editor).
     */
    setupEventListeners() {
      this.startDictationBtn?.addEventListener('click', () => this.startDictation());
      this.stopDictationBtn?.addEventListener('click', () => this.stopDictation());
      this.clearTextBtn?.addEventListener('click', () => this.clearEditor());
      this.newReportBtn?.addEventListener('click', () => this.createNewReport());
      this.saveReportBtn?.addEventListener('click', () => this.saveReport());
      this.improveReportBtn?.addEventListener('click', () => this.improveReport());
      this.refreshDictaphoneBtn?.addEventListener('click', () => this.refreshDictaphones());
      this.editor?.addEventListener('input', () => this.onEditorChange());
      // Añadir listener para botón de configuración si existe
      // document.getElementById('settings-btn')?.addEventListener('click', () => this.openSettings());
    }
  
    /**
     * Configura listeners para eventos IPC desde el proceso principal usando window.api.receive.
     */
    setupIPCListeners() {
        if (!window.api?.receive) { console.error("window.api.receive no disponible!"); return; }
        // Usar los handlers bindeados
        window.api.receive('dictation-started', this._handleDictationStarted);
        window.api.receive('dictation-stopped', this._handleDictationStopped);
        window.api.receive('transcription-update', this._handleTranscriptionUpdate);
        window.api.receive('dictaphone-connected', this._handleDictaphoneConnected);
        window.api.receive('dictaphone-disconnected', this._handleDictaphoneDisconnected);
        window.api.receive('dictaphone-action', this._handleDictaphoneAction);
        window.api.receive('dictation-error', this._handleDictationError);
        window.api.receive('dictaphone-error', this._handleDictaphoneError);
        window.api.receive('app-error', this._handleAppError);
        window.api.receive('config-changed', this._handleConfigChanged);
        window.api.receive('initialization-warning', this._handleInitializationWarning);
        window.api.receive('needs-user-setup', this._handleNeedsUserSetup);
        window.api.receive('dictaphone-reconnecting', this._handleDictaphoneReconnecting);
        window.api.receive('dictaphone-reconnect-failed', this._handleDictaphoneReconnectFailed);
        window.api.receive('status-changed', this._handleOllamaStatusChanged);
        // Listeners para modo aprendizaje
        window.api.receive('dictaphone-learning-data', this._handleDictaphoneLearningData);
        window.api.receive('dictaphone-learning-started', this._handleDictaphoneLearningStarted);
        window.api.receive('dictaphone-learning-stopped', this._handleDictaphoneLearningStopped);
  
        console.log("Renderer: Listeners IPC configurados.");
    }
  
    // --- Implementación de Handlers de Eventos IPC ---
  
    _handleDictationStarted() { this.isDictating = true; this.updateDictationUI(true); this.updateStatusMessage('Dictado en curso...', 'info'); }
    _handleDictationStopped(data) { this.isDictating = false; this.updateDictationUI(false); if (data && (data.processed !== undefined || data.original !== undefined)) { const text = data.processed ?? data.original; this.appendToEditor(text); this.updateStatusMessage(`Transcripción: ${data.replacementsMade || 0} reemplazos.`); } else { this.updateStatusMessage('Dictado detenido.'); } }
    _handleTranscriptionUpdate(data) { if (this.isDictating && data) { const text = data.processed ?? data.original ?? ''; if (!data.isFinal) this.updateStatusMessage(`Reconociendo: ${text.substring(0, 60)}...`, 'info'); } }
    _handleDictaphoneConnected(data) { this.dictaphoneConnected = true; this.updateDictaphoneStatus(true); this.updateDictaphoneInfo(data?.device); this.showNotification(`Dictáfono: ${data?.device?.product || 'Dispositivo'} conectado`, 'success'); }
    _handleDictaphoneDisconnected(data) { this.dictaphoneConnected = false; this.updateDictaphoneStatus(false); this.updateDictaphoneInfo(null); this.showNotification(`Dictáfono ${data?.device?.product || ''} desconectado (${data?.reason || ''})`, 'warn'); }
    _handleDictaphoneAction(data) { if (data?.action) this.handleDictaphoneAction(data.action); }
    _handleDictationError(data) { this.isDictating = false; this.updateDictationUI(false); const msg = `Error dictado: ${data?.message || 'Error desconocido'}`; this.updateStatusMessage(msg, 'error'); this.showNotification(msg, 'error'); }
    _handleDictaphoneError(data) { const msg = `Error dictáfono: ${data?.message || 'Error desconocido'}`; this.showNotification(msg, 'error'); }
    _handleAppError(data) { const critical = data?.critical ? 'CRÍTICO ' : ''; const msg = `Error ${critical}: ${data?.message || '?'} (${data?.type || '?'})`; this.showNotification(msg, 'error', data?.critical ? 10000 : 5000); }
    _handleConfigChanged(data) { this.showNotification(`Config '${data?.key}' actualizada.`, 'info'); if (this.appSettings && data?.key) this.appSettings[data.key] = data.value; /* Recargar o re-chequear si es necesario */ if (data?.key?.includes('ollama') || data?.key?.includes('dictaphone')) this.checkServicesStatus(); }
    _handleInitializationWarning(data) { this.showNotification(`Advertencia: ${data?.message || 'Funcionalidad limitada.'}`, 'warn', 7000); }
    _handleNeedsUserSetup(data) { this.showNotification(`Configuración Requerida (${data?.service || '?'}): ${data?.message || 'Verifique config.'}`, 'warn', 10000); }
    _handleDictaphoneReconnecting(data) { const msg = `Reconectando dictáfono (${data?.attempt}/${data?.maxAttempts})...`; this.updateStatusMessage(msg, 'warn'); this.showNotification(msg, 'warn'); }
    _handleDictaphoneReconnectFailed(data) { const msg = `Fallo reconexión dictáfono.`; this.updateStatusMessage(msg, 'error'); this.showNotification(`${msg} ${data?.message || ''}`, 'error'); this.dictaphoneConnected = false; this.updateDictaphoneStatus(false); this.updateDictaphoneInfo(null); }
    _handleOllamaStatusChanged(data) { if (data?.available !== undefined) { this.ollamaAvailable = data.available; this.updateOllamaStatus(data.available); if (!data.available) this.showNotification(`IA no disponible: ${data.error || ''}`, 'warn'); } }
    _handleDictaphoneLearningData(data) { console.log("Learning Data:", data); /* Actualizar UI de aprendizaje */ }
    _handleDictaphoneLearningStarted() { this.showNotification("Modo Aprendizaje Dictáfono: ACTIVO. Presione botones.", "info", 30000); /* Actualizar UI */ }
    _handleDictaphoneLearningStopped(data) { this.showNotification("Modo Aprendizaje Dictáfono: TERMINADO.", "success"); /* Actualizar UI, mostrar botones aprendidos 'data' */ }
  
  
    /**
     * Configura la instancia local de la Web Speech API (si es soportada por el navegador).
     * Responde a los comandos start/stop enviados desde el main process.
     */
    initializeWebSpeechHandling() {
      if (!window.api?.webSpeech) { console.warn("API WebSpeech no expuesta."); return; }
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.webSpeechRecognition = new SpeechRecognition();
        this.webSpeechRecognition.continuous = true; this.webSpeechRecognition.interimResults = true;
        this.webSpeechRecognition.onstart = () => { console.log('WebSpeech API: Listening started'); };
        this.webSpeechRecognition.onresult = (event) => {
          let interim = ''; this.webSpeechFinalTranscript = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) { if (event.results[i].isFinal) this.webSpeechFinalTranscript += event.results[i][0].transcript; else interim += event.results[i][0].transcript; }
          window.api.webSpeech.sendResult({ transcript: this.webSpeechFinalTranscript || interim, isFinal: !!this.webSpeechFinalTranscript });
        };
        this.webSpeechRecognition.onerror = (event) => { console.error('WebSpeech API Error:', event.error, event.message); window.api.webSpeech.sendError({ error: event.error, message: event.message }); };
        this.webSpeechRecognition.onend = () => { console.log('WebSpeech API: Listening ended'); window.api.webSpeech.sendEnd(this.webSpeechFinalTranscript); };
        // Registrar callbacks para control desde main
        window.api.webSpeech.listen({
          onStart: (args) => { console.log("Renderer: Start WebSpeech", args); if (this.webSpeechRecognition) { if (args?.lang) this.webSpeechRecognition.lang = args.lang; this.webSpeechFinalTranscript = ''; try { this.webSpeechRecognition.start(); } catch(e){ console.error("Error starting WebSpeech:", e); window.api.webSpeech.sendError({error: 'start-failed', message: e.message}); } } },
          onStop: () => { console.log("Renderer: Stop WebSpeech"); try { if (this.webSpeechRecognition) this.webSpeechRecognition.stop(); } catch(e){ console.error("Error stopping WebSpeech:", e); } }
        });
        console.log("Renderer: WebSpeech handling inicializado.");
      } else { console.warn('Web Speech API no soportada.'); }
    }
  
    /**
     * Verifica el estado inicial de los servicios al cargar.
     */
    async checkServicesStatus() {
      try {
        this.updateStatusMessage('Verificando servicios...', 'info');
        const [dictationStatus, dictaphoneInfo, ollamaStatus] = await Promise.allSettled([
            window.api.dictation.getStatus(), window.api.dictation.getDictaphoneInfo(), window.api.llm.getStatus()
        ]);
        // Procesar resultados (Promise.allSettled devuelve {status: 'fulfilled'/'rejected', value/reason})
        const dictStat = dictationStatus.status === 'fulfilled' ? dictationStatus.value : {available: false};
        this.updateDictationStatus(dictStat?.available || false);
        const dphInfo = dictaphoneInfo.status === 'fulfilled' ? dictaphoneInfo.value : {isConnected: false};
        this.dictaphoneConnected = dphInfo?.isConnected || false;
        this.updateDictaphoneStatus(this.dictaphoneConnected);
        this.updateDictaphoneInfo(this.dictaphoneConnected ? dphInfo.device : null);
        const ollStat = ollamaStatus.status === 'fulfilled' ? ollamaStatus.value : {available: false};
        this.ollamaAvailable = ollStat?.available || false;
        this.updateOllamaStatus(this.ollamaAvailable);
        if(this.improveReportBtn) this.improveReportBtn.disabled = !this.ollamaAvailable;
        this.updateStatusMessage('Servicios verificados.');
      } catch (error) {
        console.error('Error fatal verificando estado servicios:', error);
        this.updateStatusMessage(`Error verificando servicios: ${error.message}`, 'error');
        this.updateDictationStatus(false); this.updateDictaphoneStatus(false); this.updateOllamaStatus(false);
        if(this.improveReportBtn) this.improveReportBtn.disabled = true;
      }
    }
  
    /**
     * Carga la configuración de la aplicación.
     */
    async loadSettings() {
      try {
          const response = await window.api.config.getAllSettings();
          if (response?.success) { this.appSettings = response.settings || {}; console.log('Settings cargados:', this.appSettings); }
          else { this.showNotification(`Error cargando config: ${response?.error}`, 'warn'); }
      } catch (error) { this.showNotification(`Error fatal cargando config: ${error.message}`, 'error'); }
    }
  
    /**
     * Carga las plantillas disponibles.
     */
    async loadTemplates() {
      try {
          const result = await window.api.templates.getAll();
          if (result?.success) { this.templates = result.templates || []; }
          else { throw new Error(result?.error || 'Error desconocido'); }
          this.updateTemplatesList();
      } catch (error) { this.showNotification(`Error cargando plantillas: ${error.message}`, 'error'); this.templates = []; this.updateTemplatesList(); }
    }
  
    /**
     * Actualiza la lista de plantillas en la UI.
     */
    updateTemplatesList() {
      if (!this.templatesList) return; this.templatesList.innerHTML = '';
      if (this.templates.length === 0) { const li = document.createElement('li'); li.textContent = 'No hay plantillas.'; li.style.padding = '5px 8px'; this.templatesList.appendChild(li); return; }
      this.templates.forEach(template => {
          const li = document.createElement('li'); const a = document.createElement('a');
          a.href = '#'; a.textContent = template.name; a.dataset.templateId = template.id;
          a.title = `${template.modality || ''} - ${template.specialty || 'General'}`; a.role = 'button';
          a.addEventListener('click', (e) => { e.preventDefault(); this.loadTemplate(template.id); });
          li.appendChild(a); this.templatesList.appendChild(li);
      });
    }
  
    /**
     * Configura el editor.
     */
    setupEditor() { if (!this.editor) return; this.editor.disabled = false; this.editor.value = this.currentReport.content; this.updateWordCount(); }
  
    /**
     * Inicia el dictado llamando al main process.
     */
    async startDictation() {
      if (this.isDictating) return;
      try {
        this.updateStatusMessage('Iniciando...', 'info');
        // Obtener idioma de la configuración actual
        const lang = this.appSettings['preference.dictationLanguage'] || 'es-ES';
        const result = await window.api.dictation.start({ language: lang });
        if (!result?.success) throw new Error(result?.error || 'Fallo al iniciar');
        // UI se actualiza en _handleDictationStarted
      } catch (error) { this.updateStatusMessage(`Error inicio dictado: ${error.message}`, 'error'); this.showNotification(`Error: ${error.message}`, 'error'); this.isDictating = false; this.updateDictationUI(false); }
    }
  
    /**
     * Detiene el dictado llamando al main process.
     */
    async stopDictation() {
      if (!this.isDictating) return;
      try { this.updateStatusMessage('Deteniendo...', 'info'); await window.api.dictation.stop(); }
      catch (error) { this.updateStatusMessage(`Error deteniendo dictado: ${error.message}`, 'error'); this.showNotification(`Error: ${error.message}`, 'error'); this.isDictating = false; this.updateDictationUI(false); }
    }
  
    /**
     * Limpia el contenido del editor.
     */
    clearEditor() {
      if (this.currentReport.modified && !confirm('¿Limpiar el texto actual? Se perderán los cambios no guardados.')) return;
      if (this.editor) { this.editor.value = ''; this.currentReport.content = ''; this.currentReport.modified = false; this.updateWordCount(); this.updateStatusMessage('Editor limpiado.'); }
    }
  
    /**
     * Prepara la UI para un nuevo informe.
     */
    createNewReport() {
      if (this.currentReport.modified && !confirm('¿Crear nuevo informe? Se perderán los cambios no guardados.')) return;
      this.currentReport = { id: null, title: 'Nuevo Informe', content: '', specialty: 'General', modality: null, modified: false };
      if (this.editor) this.editor.value = '';
      this.updateWordCount(); this.updateStatusMessage('Nuevo informe listo.');
      // Podrías también resetear título de ventana o campos relacionados
    }
  
    /**
     * Guarda el informe actual (requiere implementación IPC real).
     */
    async saveReport() {
      try {
          this.updateStatusMessage('Guardando...', 'info'); if (this.saveReportBtn) this.saveReportBtn.disabled = true;
          this.currentReport.content = this.editor?.value || '';
          // Llamada IPC para guardar
          const result = await window.api.templates.save(this.currentReport); // saveTemplate puede crear/actualizar
          if (result?.success) {
              if (result.id && !this.currentReport.id) this.currentReport.id = result.id; // Actualizar ID si es nuevo
              this.currentReport.modified = false;
              this.updateStatusMessage('Informe guardado.'); this.showNotification('Guardado', 'success');
          } else { throw new Error(result?.error || 'Error al guardar'); }
      } catch (error) { this.updateStatusMessage(`Error guardando: ${error.message}`, 'error'); this.showNotification(`Error: ${error.message}`, 'error'); }
      finally { if (this.saveReportBtn) this.saveReportBtn.disabled = false; }
    }
  
    /**
     * Solicita mejora del texto actual usando Ollama.
     */
    async improveReport() {
      if (!this.editor?.value.trim()) { this.showNotification('No hay texto para mejorar', 'info'); return; }
      if (!this.ollamaAvailable) { this.showNotification('Asistente IA no disponible', 'error'); return; }
      try {
          this.updateStatusMessage('Mejorando con IA...', 'info'); if (this.improveReportBtn) this.improveReportBtn.disabled = true;
          const reportText = this.editor.value; const specialty = this.currentReport.specialty || null;
          // Llamar a la API expuesta
          const result = await window.api.llm.request('improveReport', reportText, specialty);
          if (result?.success && result.data) {
              const improvedText = result.data.response || result.data.message?.content;
              if (!improvedText) throw new Error("Respuesta IA vacía.");
              // Confirmar reemplazo
              if (confirm(`Texto Mejorado:\n-------------\n${improvedText.substring(0, 300)}...\n-------------\n¿Reemplazar texto actual?`)) {
                  this.editor.value = improvedText; this.currentReport.content = improvedText;
                  this.currentReport.modified = true; this.updateWordCount();
                  this.updateStatusMessage('Informe mejorado con IA.');
              } else { this.updateStatusMessage('Mejora cancelada.'); }
          } else { throw new Error(result?.error || 'Fallo al mejorar'); }
      } catch (error) { this.updateStatusMessage(`Error mejora IA: ${error.message}`, 'error'); this.showNotification(`Error IA: ${error.message}`, 'error'); }
      finally { if (this.improveReportBtn) this.improveReportBtn.disabled = false; }
    }
  
    /**
     * Carga el contenido de una plantilla en el editor.
     */
    async loadTemplate(templateId) {
       if (this.currentReport.modified && !confirm('¿Cargar plantilla? Se perderán cambios.')) return;
       const template = this.templates.find(t => t.id === templateId); if (!template) return;
       try {
           this.updateStatusMessage(`Cargando ${template.name}...`, 'info');
           // Usar contenido de la plantilla cargada desde DB
           const templateContent = template.content || `# ${template.name}\n\n[Contenido...]`;
           if (this.editor) this.editor.value = templateContent;
           this.currentReport = { ...this.currentReport, id: template.id, title: template.name, content: templateContent, specialty: template.specialty, modality: template.modality, modified: false };
           this.updateWordCount(); this.updateStatusMessage(`Plantilla cargada: ${template.name}.`);
       } catch (error) { this.showNotification(`Error cargando plantilla: ${error.message}`, 'error'); }
    }
  
    /**
     * Busca dictáfonos conectados y permite seleccionar uno.
     */
    async refreshDictaphones() {
      try {
        this.updateStatusMessage('Buscando dictáfonos...', 'info'); if (this.refreshDictaphoneBtn) this.refreshDictaphoneBtn.disabled = true;
        const dictaphones = await window.api.dictation.getConnectedDictaphones();
        if (dictaphones?.length > 0) { this.showDictaphoneSelector(dictaphones); }
        else { this.updateStatusMessage('No hay dictáfonos.'); this.updateDictaphoneInfo(null); this.updateDictaphoneStatus(false); this.showNotification('No se detectaron dictáfonos.', 'info'); }
      } catch (error) { this.updateStatusMessage(`Error buscando: ${error.message}`, 'error'); this.showNotification(`Error: ${error.message}`, 'error'); }
      finally { if (this.refreshDictaphoneBtn) this.refreshDictaphoneBtn.disabled = false; }
    }
  
    /**
     * Muestra un selector simple (prompt) para elegir dictáfono.
     */
    showDictaphoneSelector(dictaphones) {
      const deviceNames = dictaphones.map((d, i) => `${i + 1}. ${d.manufacturer || '?'} ${d.product || 'Dispositivo'}`);
      const message = `Dictáfonos disponibles:\n${deviceNames.join('\n')}\n\nNúmero a usar (0 para cancelar):`;
      const selection = prompt(message, '1');
      if (selection === null || selection === '0') return;
      const index = parseInt(selection) - 1;
      if (!isNaN(index) && index >= 0 && index < dictaphones.length) this.setActiveDictaphone(dictaphones[index]);
      else this.showNotification('Selección inválida', 'error');
    }
  
    /**
     * Intenta activar un dictáfono específico.
     */
    async setActiveDictaphone(device) {
      if (!device?.path) { this.showNotification('Dispositivo inválido', 'error'); return; }
      try {
        this.updateStatusMessage(`Activando: ${device.product || '?'}...`, 'info');
        const result = await window.api.dictation.setActiveDictaphone(device.path);
        if (!result?.success) throw new Error(result?.error || 'Fallo al activar');
        // Esperar evento 'dictaphone-connected' para actualizar UI
        this.updateStatusMessage('Dictáfono activado.');
      } catch (error) { this.updateStatusMessage(`Error activando: ${error.message}`, 'error'); this.showNotification(`Error: ${error.message}`, 'error'); }
    }
  
    /**
     * Maneja acciones recibidas del dictáfono (mapeadas).
     */
    handleDictaphoneAction(action) {
      this.showNotification(`Acción Dictáfono: ${action}`, 'info');
      switch (action) {
        case 'start_dictation': case 'record': this.startDictation(); break;
        case 'toggle_dictation': case 'play_pause': if (this.isDictating) this.stopDictation(); else this.startDictation(); break;
        case 'stop_dictation': case 'stop': this.stopDictation(); break;
        case 'new_report': this.createNewReport(); break;
        case 'save_report': this.saveReport(); break;
        case 'improve_report': this.improveReport(); break;
        default: console.warn(`Acción dictáfono no manejada: ${action}`);
      }
    }
  
    /**
     * Añade texto al editor en la posición actual del cursor.
     */
    appendToEditor(text) {
      if (!text || !this.editor) return;
      const editor = this.editor; const start = editor.selectionStart; const end = editor.selectionEnd;
      const currentValue = editor.value;
      const precedingChar = currentValue.substring(start - 1, start);
      const needsSpacer = start > 0 && !/\s$/.test(precedingChar); // Añadir espacio si no hay uno antes
      const spacer = needsSpacer ? ' ' : '';
      const textToInsert = spacer + text;
      editor.value = currentValue.substring(0, start) + textToInsert + currentValue.substring(end);
      const newPosition = start + textToInsert.length;
      editor.setSelectionRange(newPosition, newPosition);
      this.currentReport.content = editor.value; this.currentReport.modified = true;
      this.onEditorChange(); // Actualizar contador palabras, etc.
      editor.focus(); editor.scrollTop = editor.scrollHeight; // Enfocar y scroll
    }
  
    /**
     * Se dispara al cambiar el editor (con debounce).
     */
    onEditorChange() {
      clearTimeout(this.editorUpdateTimeout);
      this.editorUpdateTimeout = setTimeout(() => {
        this.updateWordCount();
        if (this.editor && this.currentReport.content !== this.editor.value) this.currentReport.modified = true;
        this.currentReport.content = this.editor?.value || '';
      }, 300);
    }
  
    /**
     * Actualiza el contador de palabras.
     */
    updateWordCount() {
      if (!this.wordCount || !this.editor) return;
      const text = this.editor.value || '';
      const wordCount = text.split(/\s+/).filter(word => word.length > 0).length;
      this.wordCount.textContent = `${wordCount} palabra${wordCount === 1 ? '' : 's'}`;
    }
  
    // --- Actualizadores de UI de Estado ---
    updateDictationStatus(available) { const el = this.dictationStatus; if(el) { el.classList.toggle('active', !!available); el.setAttribute('aria-label', `Dictado ${available ? 'disponible' : 'no disponible'}`); } }
    updateDictaphoneStatus(connected) { const el = this.dictaphoneStatus; if(el) { el.classList.toggle('active', !!connected); el.setAttribute('aria-label', `Dictáfono ${connected ? 'conectado' : 'desconectado'}`); } }
    updateOllamaStatus(available) { const el = this.ollamaStatus; if(el) { el.classList.toggle('active', !!available); el.setAttribute('aria-label', `IA ${available ? 'disponible' : 'no disponible'}`); } if(this.improveReportBtn) this.improveReportBtn.disabled = !available; }
    updateDictaphoneInfo(device) { if (!this.dictaphoneInfo) return; if (device) { const name = `${device.manufacturer || '?'} ${device.product || '?'}`; this.dictaphoneInfo.textContent = `Activo: ${name}`; this.dictaphoneInfo.setAttribute('aria-label', `Activo: ${name}`); } else { this.dictaphoneInfo.textContent = 'No conectado'; this.dictaphoneInfo.setAttribute('aria-label', 'No conectado'); } }
    updateDictationUI(isDictating) { if (this.startDictationBtn) this.startDictationBtn.disabled = isDictating; if (this.stopDictationBtn) this.stopDictationBtn.disabled = !isDictating; if (this.editor) { this.editor.classList.toggle('dictating', isDictating); this.editor.setAttribute('aria-live', isDictating ? 'polite' : 'off'); } }
    updateStatusMessage(message, type = 'info') { if (!this.statusMessage) return; this.statusMessage.textContent = message; this.statusMessage.className = `status-message ${type}`; this.statusMessage.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite'); }
  
    /**
     * Muestra una notificación temporal.
     */
    showNotification(message, type = 'info', duration = null) {
      if (!this.notification) return;
      if (this.notificationTimeout) clearTimeout(this.notificationTimeout);
      this.notification.textContent = message;
      this.notification.className = `notification ${type}`;
      this.notification.setAttribute('role', 'alert');
      this.notification.setAttribute('aria-live', (type === 'error' || type === 'warn') ? 'assertive' : 'polite');
      this.notification.style.display = 'block';
      const delay = duration || (type === 'error' ? 6000 : type === 'warn' ? 5000 : 3000); // Duración por defecto
      this.notificationTimeout = setTimeout(() => { this.notification.style.display = 'none'; }, delay);
    }
  
  } // Fin clase RadiologyApp
  
  // Iniciar la aplicación cuando el DOM esté listo
  document.addEventListener('DOMContentLoaded', () => {
      // Verificar si la API existe antes de instanciar
      if(window.api) {
          const appInstance = new RadiologyApp();
          appInstance.initialize();
      } else {
          // Mostrar error grave si preload falló
          document.body.innerHTML = `<div style="color: red; padding: 20px; font-family: sans-serif;">
              <h1>Error Crítico</h1>
              <p>No se pudo establecer la comunicación interna con la aplicación (preload script falló).</p>
              <p>Por favor, reinicie la aplicación. Si el problema persiste, reinstale o contacte soporte.</p>
          </div>`;
      }
  });