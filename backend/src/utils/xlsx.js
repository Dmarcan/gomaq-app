// Escritor minimo de .xlsx (una hoja) sin dependencias: un ZIP armado con zlib de Node y los XML justos.
//
// Celdas admitidas en `filas` (matriz: filas[i][j] es la celda de la fila i+1, columna j+1):
//   null, undefined o ''      celda vacia (no se escribe)
//   string                    texto en linea (inlineStr), con escape XML y sin caracteres de control
//   number                    numero (debe ser finito)
//   { fecha: 'AAAA-MM-DD' }   fecha real de Excel: numero de serie con formato dd-mm-yyyy
//
// Solo valores, nunca formulas. Partes: [Content_Types].xml, _rels/.rels, xl/workbook.xml,
// xl/_rels/workbook.xml.rels, xl/styles.xml y xl/worksheets/sheet1.xml.

const zlib = require('node:zlib');

const ENCABEZADO_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const ESTILO_FECHA = 1;
const COLUMNAS_MAX = 16384;
const FILAS_MAX = 1048576;

// CRC32 propio (la tabla es corta): no depende de que zlib.crc32 exista en la version de Node.
const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i += 1) c = TABLA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Texto seguro para XML 1.0: quita los caracteres de control y escapa & < > " '. */
function escaparXml(texto) {
    return String(texto)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Referencia de columna: 0 -> A, 25 -> Z, 26 -> AA. */
function letraColumna(indice) {
    let n = indice + 1;
    let letras = '';
    while (n > 0) {
        const resto = (n - 1) % 26;
        letras = String.fromCharCode(65 + resto) + letras;
        n = Math.floor((n - 1) / 26);
    }
    return letras;
}

/** 'AAAA-MM-DD' -> numero de serie de Excel (dias desde 1899-12-30). */
function serieExcel(dia) {
    if (typeof dia !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error(`fecha invalida para Excel: ${dia}`);
    const ms = Date.parse(`${dia}T00:00:00Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== dia) throw new Error(`fecha invalida para Excel: ${dia}`);
    const serie = Math.round((ms - Date.UTC(1899, 11, 30)) / 86400000);
    if (serie < 1) throw new Error(`fecha anterior a 1900: ${dia}`);
    return serie;
}

function xmlCelda(celda, ref) {
    if (celda === null || celda === undefined || celda === '') return '';
    if (typeof celda === 'number') {
        if (!Number.isFinite(celda)) throw new Error(`numero no finito en ${ref}`);
        return `<c r="${ref}"><v>${celda}</v></c>`;
    }
    if (typeof celda === 'string') {
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escaparXml(celda)}</t></is></c>`;
    }
    if (typeof celda === 'object' && typeof celda.fecha === 'string') {
        return `<c r="${ref}" s="${ESTILO_FECHA}"><v>${serieExcel(celda.fecha)}</v></c>`;
    }
    throw new Error(`tipo de celda no admitido en ${ref}`);
}

function xmlHoja(filas) {
    if (filas.length > FILAS_MAX) throw new Error('demasiadas filas para una hoja de Excel');
    const partes = [];
    filas.forEach((fila, i) => {
        if (!Array.isArray(fila) || fila.length === 0) return;
        if (fila.length > COLUMNAS_MAX) throw new Error('demasiadas columnas para una hoja de Excel');
        let celdas = '';
        fila.forEach((celda, j) => { celdas += xmlCelda(celda, `${letraColumna(j)}${i + 1}`); });
        if (celdas) partes.push(`<row r="${i + 1}">${celdas}</row>`);
    });
    return `${ENCABEZADO_XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${partes.join('')}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `${ENCABEZADO_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';

const RELS_RAIZ = `${ENCABEZADO_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

const RELS_LIBRO = `${ENCABEZADO_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

// estilo 0 = general, estilo 1 = fecha dd-mm-yyyy (formato propio 164)
const STYLES = `${ENCABEZADO_XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\-mm\\-yyyy"/></numFmts>'
    + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

function xmlLibro(hoja) {
    return `${ENCABEZADO_XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets><sheet name="${escaparXml(hoja)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

/** Arma el ZIP (metodo deflate) con las partes dadas: [{ nombre, datos: Buffer }]. */
function armarZip(partes) {
    const locales = [];
    const centrales = [];
    let desplazamiento = 0;
    // fecha y hora DOS fijas (1980-01-01 00:00): el mismo contenido da siempre los mismos bytes
    const DOS_HORA = 0;
    const DOS_FECHA = 0x0021;
    for (const { nombre, datos } of partes) {
        const nom = Buffer.from(nombre, 'utf8');
        const comprimido = zlib.deflateRawSync(datos);
        const crc = crc32(datos);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version necesaria
        local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt16LE(DOS_HORA, 10);
        local.writeUInt16LE(DOS_FECHA, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comprimido.length, 18);
        local.writeUInt32LE(datos.length, 22);
        local.writeUInt16LE(nom.length, 26);
        local.writeUInt16LE(0, 28);
        locales.push(local, nom, comprimido);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version que lo hizo
        central.writeUInt16LE(20, 6); // version necesaria
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(DOS_HORA, 12);
        central.writeUInt16LE(DOS_FECHA, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(comprimido.length, 20);
        central.writeUInt32LE(datos.length, 24);
        central.writeUInt16LE(nom.length, 28);
        central.writeUInt32LE(desplazamiento, 42);
        centrales.push(central, nom);
        desplazamiento += local.length + nom.length + comprimido.length;
    }
    const dirCentral = Buffer.concat(centrales);
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0);
    fin.writeUInt16LE(partes.length, 8);
    fin.writeUInt16LE(partes.length, 10);
    fin.writeUInt32LE(dirCentral.length, 12);
    fin.writeUInt32LE(desplazamiento, 16);
    return Buffer.concat([...locales, dirCentral, fin]);
}

/**
 * Crea el libro de una sola hoja.
 * @param {{ hoja?: string, filas: Array<Array<null|string|number|{fecha: string}>> }} opciones
 * @returns {Buffer} contenido del .xlsx
 */
function crearXlsx({ hoja = 'Hoja1', filas = [] } = {}) {
    if (typeof hoja !== 'string' || hoja.length < 1 || hoja.length > 31 || /[[\]:*?/\\]/.test(hoja)) {
        throw new Error('nombre de hoja invalido para Excel');
    }
    const texto = (xml) => Buffer.from(xml, 'utf8');
    return armarZip([
        { nombre: '[Content_Types].xml', datos: texto(CONTENT_TYPES) },
        { nombre: '_rels/.rels', datos: texto(RELS_RAIZ) },
        { nombre: 'xl/workbook.xml', datos: texto(xmlLibro(hoja)) },
        { nombre: 'xl/_rels/workbook.xml.rels', datos: texto(RELS_LIBRO) },
        { nombre: 'xl/styles.xml', datos: texto(STYLES) },
        { nombre: 'xl/worksheets/sheet1.xml', datos: texto(xmlHoja(filas)) },
    ]);
}

const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

module.exports = { crearXlsx, serieExcel, letraColumna, escaparXml, crc32, TIPO_XLSX };
