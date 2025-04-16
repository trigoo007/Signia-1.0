// Define tipos de errores estandarizados para usar en la aplicación

const ERROR_TYPES = Object.freeze({
    // Errores de Inicialización / Configuración
    INITIALIZATION: 'initialization_error',
    PRECHECK_ERROR: 'precheck_error',
    REQUIREMENTS_ERROR: 'requirements_error',
    CONFIG_LOAD_ERROR: 'config_load_error',
    CONFIG_SAVE_ERROR: 'config_save_error',
    DATABASE_INIT_ERROR: 'database_init_error',
    SPEECH_INIT_ERROR: 'speech_init_error',
    DICTAPHONE_INIT_ERROR: 'dictaphone_init_error',
    OLLAMA_INIT_ERROR: 'ollama_init_error',
    CONFIGURATION: 'configuration_error',
  
    // Errores de Base de Datos
    DATABASE_ERROR: 'database_error',
    DATABASE_QUERY_ERROR: 'database_query_error',
    DATABASE_MIGRATION_ERROR: 'database_migration_error',
    DATABASE_CONNECTION_ERROR: 'database_connection_error',
  
    // Errores de Reconocimiento de Voz / Dictado
    SPEECH_RECOGNITION: 'speech_recognition_error',
    SPEECH_UNAVAILABLE: 'speech_unavailable_error',
    SPEECH_STRATEGY_ERROR: 'speech_strategy_error',
  
    // Errores de Dictáfono
    DICTAPHONE_CONNECTION: 'dictaphone_connection_error',
    DICTAPHONE_READ: 'dictaphone_read_error',
    DICTAPHONE_WRITE: 'dictaphone_write_error',
    DICTAPHONE_MAPPING: 'dictaphone_mapping_error',
    DICTAPHONE_UNSUPPORTED: 'dictaphone_unsupported_error',
    DICTAPHONE_CONFIG_ERROR: 'dictaphone_config_error',
  
    // Errores de Procesamiento de Texto / Términos
    TERM_REPLACEMENT_ERROR: 'term_replacement_error',
  
    // Errores de Ollama / IA
    OLLAMA_CONNECTION_ERROR: 'ollama_connection_error',
    OLLAMA_REQUEST_ERROR: 'ollama_request_error',
    OLLAMA_UNAVAILABLE: 'ollama_unavailable_error',
    OLLAMA_MODEL_ERROR: 'ollama_model_error',
  
    // Errores de Comunicación IPC
    IPC_ERROR: 'ipc_error',
  
    // Errores de Sistema de Archivos
    FILESYSTEM_ERROR: 'filesystem_error',
  
    // Errores Inesperados / Desconocidos
    UNCAUGHT_EXCEPTION: 'uncaught_exception',
    UNHANDLED_REJECTION: 'unhandled_rejection',
    UNKNOWN: 'unknown_error',
  });
  
  module.exports = ERROR_TYPES;