const { PDFParse } = require('pdf-parse');

// extrae el texto seleccionable de un PDF (si lo tiene). Best-effort: si el PDF es una
// imagen escaneada o esta corrupto, devuelve string vacio en vez de lanzar error.
async function leerTextoPdf(buffer) {
    let parser;
    try {
        parser = new PDFParse({ data: buffer });
        const resultado = await parser.getText();
        return resultado.text || '';
    } catch (_) {
        return '';
    } finally {
        if (parser) await parser.destroy();
    }
}

module.exports = { leerTextoPdf };
