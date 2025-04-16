// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Canales válidos para window.api.receive (seguridad)
const validReceiveChannels = [
    'dictation-started', 'dictation-stopped', 'transcription-update', 'dictation-error',
    'dictaphone-connected', 'dictaphone-disconnected', 'dictaphone-action', 'dictaphone-error',
    'dictaphone-reconnecting', 'dictaphone-reconnect-failed', 'dictaphone-learning-data',
    'dictaphone-learning-started', 'dictaphone-learning-stopped',
    'app-error', 'config-changed', 'config-reloaded', 'initialization-warning',
    'needs-user-setup', 'pull-progress', 'status-changed', 'busy', 'idle'
];

// Mapa interno para listeners del renderer
const listeners = new Map();

// API expuesta al renderer
contextBridge.exposeInMainWorld('api', {
  // --- Renderer -> Main (Invocaciones) ---
  ping: () => ipcRenderer.invoke('ping'),
  restartApp: () => ipcRenderer.send('restart-app'), // No necesita respuesta
  quitApp: () => ipcRenderer.send('quit-app'),       // No necesita respuesta

  dictation: {
    start: (options = {}) => ipcRenderer.invoke('start-dictation', options),
    stop: () => ipcRenderer.invoke('stop-dictation'),
    getStatus: () => ipcRenderer.invoke('get-dictation-status'),
    getDictaphoneInfo: () => ipcRenderer.invoke('get-dictaphone-info'),
    getConnectedDictaphones: () => ipcRenderer.invoke('get-connected-dictaphones'),
    setActiveDictaphone: (devicePath) => ipcRenderer.invoke('set-active-dictaphone', devicePath),
    saveDictaphoneConfig: (config) => ipcRenderer.invoke('save-dictaphone-config', config),
    getDefaultDictaphoneMappings: (modelInfo) => ipcRenderer.invoke('get-default-dictaphone-mappings', modelInfo),
    startLearningMode: () => ipcRenderer.invoke('start-dictaphone-learning'),
    stopLearningMode: () => ipcRenderer.invoke('stop-dictaphone-learning'),
    assignButton: (formattedData, action) => ipcRenderer.invoke('assign-dictaphone-button', { formattedData, action })
  },

  llm: {
    request: (methodName, ...args) => ipcRenderer.invoke('ollama-request', methodName, ...args),
    getStatus: () => ipcRenderer.invoke('get-ollama-status'),
    updateConfig: (config) => ipcRenderer.invoke('update-ollama-config', config)
    // improveReport se llama vía: api.llm.request('improveReport', text, specialty)
  },

  terms: {
      processText: (text, options) => ipcRenderer.invoke('process-medical-text', text, options),
      addTerm: (heard, correct, options) => ipcRenderer.invoke('add-medical-term', heard, correct, options),
      getSuggestions: (partial, options) => ipcRenderer.invoke('get-medical-term-suggestions', partial, options)
  },

  config: {
      getSetting: (key) => ipcRenderer.invoke('get-setting', key),
      getAllSettings: () => ipcRenderer.invoke('get-all-settings'),
      saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),
      reloadConfig: () => ipcRenderer.invoke('reload-config')
  },

  templates: {
      getAll: () => ipcRenderer.invoke('get-templates'),
      save: (templateData) => ipcRenderer.invoke('save-template', templateData)
      // Podrías añadir get(id), delete(id) aquí
  },

  errors: {
      getErrorLog: (errorId) => ipcRenderer.invoke('get-error-log', errorId),
      getRecentErrors: (count) => ipcRenderer.invoke('get-recent-errors', count)
  },


  // --- Main -> Renderer (Eventos) ---
  receive: (channel, func) => {
    if (validReceiveChannels.includes(channel)) {
        if (!listeners.has(channel)) listeners.set(channel, []);
        const channelListeners = listeners.get(channel);
        if (!channelListeners.includes(func)) channelListeners.push(func);

        // Registrar listener IPC real solo una vez por canal
        if (ipcRenderer.listenerCount(channel) === 0) {
            ipcRenderer.on(channel, (event, ...args) => {
                listeners.get(channel)?.forEach(callback => {
                    try { callback(...args); } catch (e) { console.error(`Error en callback renderer (${channel}):`, e); }
                });
            });
        }
    } else { console.warn(`Preload: Intento de registro para canal inválido: ${channel}`); }
  },

  removeListener: (channel, func) => {
     if (validReceiveChannels.includes(channel) && listeners.has(channel)) {
         const channelListeners = listeners.get(channel);
         const index = channelListeners.indexOf(func);
         if (index !== -1) {
             channelListeners.splice(index, 1);
             // Opcional: Limpiar listener IPC si ya no hay suscriptores en el renderer
             // if (channelListeners.length === 0) { ipcRenderer.removeAllListeners(channel); listeners.delete(channel); }
         }
     }
  },

  // --- API para WebSpeech Strategy ---
  webSpeech: {
     isReady: () => ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window), // Verifica si la API existe en el contexto del renderer
     sendResult: (result) => ipcRenderer.send('web-speech-result', result),
     sendError: (error) => ipcRenderer.send('web-speech-error', error),
     sendEnd: (finalTranscript) => ipcRenderer.send('web-speech-end', finalTranscript),
     // Registra callbacks para que el main process pueda controlar la Web Speech API del renderer
     listen: (callbacks) => {
         ipcRenderer.on('start-web-speech', (event, args) => callbacks?.onStart?.(args));
         ipcRenderer.on('stop-web-speech', () => callbacks?.onStop?.());
     }
  }

});

// Puedes añadir un log aquí para confirmar que el preload se ejecutó
// console.log('Preload script for Signia executed.');