// tests/test-utils.js
const path = require('path');

// --- Mocks ---
// (Adaptar a tu framework de pruebas, ej. Jest)
const mockLoggerFunc = jest.fn();
const mockLogger = {
  debug: mockLoggerFunc, info: mockLoggerFunc, warn: mockLoggerFunc,
  error: mockLoggerFunc, fatal: mockLoggerFunc, warnOnce: mockLoggerFunc, errorOnce: mockLoggerFunc,
};

const mockDbManager = {
    getSetting: jest.fn(), saveSetting: jest.fn(),
    getAllSettings: jest.fn().mockResolvedValue({}),
    addOrUpdateMedicalTerm: jest.fn(),
    getAllTemplates: jest.fn().mockResolvedValue([]),
    findExactTerm: jest.fn().mockResolvedValue(null),
    getMostFrequentTerms: jest.fn().mockResolvedValue([]),
    incrementTermFrequency: jest.fn().mockResolvedValue({ changes: 1 }),
    // ... otros métodos ...
    initialize: jest.fn().mockResolvedValue(true),
    cleanup: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(async (action) => await action(mockDbManager)), // Ejecuta la acción pasada
    run: jest.fn().mockResolvedValue({ changes: 0, lastID: 0}),
    get: jest.fn().mockResolvedValue(undefined),
    all: jest.fn().mockResolvedValue([]),
};

// --- Helpers ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Configuración E2E (Ejemplo Spectron - ¡Verificar compatibilidad!) ---
/*
const { Application } = require('spectron');
const electronPath = require('electron'); // O ruta al binario

const setupSpectronApp = () => {
  return new Application({
    path: electronPath,
    args: [path.join(__dirname, '..')], // Asume que tests están en Signia/tests/
    // ... más opciones ...
  });
};
*/

// --- Exportaciones ---
module.exports = {
  mockLogger,
  mockDbManager,
  delay,
  // setupSpectronApp, // Si usas Spectron
};

// Notas:
// - Este es un punto de partida. Expande con lo que necesites.
// - Considera mocks para OllamaService, HID, etc., para pruebas unitarias.
// - Para E2E, investiga Playwright para Electron o el estado actual de Spectron.