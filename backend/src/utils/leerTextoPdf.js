const { PDFParse } = require('pdf-parse');

// Las guias y facturas de GOMAQ tienen 1 o 2 paginas: leer mas no aporta y un PDF con decenas de
// miles de paginas (cabe en 10 MB) consumia minutos de CPU por peticion. Se leen las primeras.
const MAX_PAGINAS = 5;
const TIMEOUT_MS = 8000;

// extrae el texto seleccionable de un PDF (si lo tiene). Best-effort: si el PDF es una
// imagen escaneada, esta corrupto o tarda demasiado, devuelve string vacio en vez de lanzar error.
async function leerTextoPdf(buffer, { maxPaginas = MAX_PAGINAS, timeoutMs = TIMEOUT_MS } = {}) {
    let parser;
    let temporizador;
    try {
        parser = new PDFParse({ data: buffer });
        const limite = new Promise((resolve) => {
            temporizador = setTimeout(() => resolve(null), timeoutMs);
        });
        const resultado = await Promise.race([parser.getText({ first: maxPaginas }), limite]);
        return (resultado && resultado.text) || '';
    } catch (_) {
        return '';
    } finally {
        clearTimeout(temporizador);
        // destroy() puede colgarse si el parseo sigue en curso: no se espera mas alla del limite
        if (parser) await Promise.race([parser.destroy().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    }
}

module.exports = { leerTextoPdf, MAX_PAGINAS, TIMEOUT_MS };
