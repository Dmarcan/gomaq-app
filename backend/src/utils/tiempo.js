// Constantes de tiempo compartidas por las reglas de dias y de horas del telefono.

const MS_DIA = 24 * 60 * 60 * 1000;

// margen para el reloj de un telefono adelantado: una hora un poco en el futuro no es dudosa
const TOLERANCIA_FUTURO_MS = 2 * 60 * 1000;

module.exports = { MS_DIA, TOLERANCIA_FUTURO_MS };
