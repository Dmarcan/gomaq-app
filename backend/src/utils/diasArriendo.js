// hora (24h) a partir de la cual el dia de despacho ya no cuenta como dia de arriendo
// (entrevista la administrativa: "si se fue a las 10 de la manana se cobra ese dia, si se fue a las 3
// de la tarde no se cobra ese dia" - valor pendiente de confirmar el corte exacto con ella).
// Es el valor por defecto: la configuracion vigente vive en la tabla `configuracion`.
const HORA_CORTE = 13;

// Version dependiente de process.env.TZ (server.js y el worker la fijan a Santiago). La usa
// utils/rentabilidad.js; el codigo nuevo usa inicioCobroDia, que no depende del proceso.
function calcularInicioCobro(fechaDespacho, horaCorte = HORA_CORTE) {
    const inicio = new Date(fechaDespacho);
    if (inicio.getHours() >= horaCorte) {
        inicio.setDate(inicio.getDate() + 1);
    }
    inicio.setHours(0, 0, 0, 0);
    return inicio;
}

// proyecta una fecha local a un "dia de calendario" en un marco sin cambios de hora:
// Chile tiene DST (dias de 23/25 horas), asi que restar milisegundos y dividir por 24h
// produce off-by-one dos veces al ano. Date.UTC de los componentes año/mes/dia es el
// patron estandar para aritmetica de dias de calendario.
function diaCalendarioUtc(fecha) {
    return Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
}

// Dias facturables: desde el dia de inicio de cobro hasta el dia de la recepcion INCLUSIVE
// (regla de cierre pendiente de confirmar con la administrativa, igual que HORA_CORTE). Con
// incluirDiaRecepcion = false el dia de la recepcion no cuenta. Sin recepcion: hasta hoy inclusive.
// Los valores por defecto mantienen el comportamiento de siempre.
function calcularDiasTranscurridos(fechaDespacho, fechaFin, { horaCorte = HORA_CORTE, incluirDiaRecepcion = true } = {}) {
    const inicioCobro = calcularInicioCobro(fechaDespacho, horaCorte);
    const fin = fechaFin ? new Date(fechaFin) : new Date();
    const dias = (diaCalendarioUtc(fin) - diaCalendarioUtc(inicioCobro)) / (1000 * 60 * 60 * 24) + (incluirDiaRecepcion ? 1 : 0);
    return Math.max(0, dias);
}

// ---------------------------------------------------------------------------------------------
// Funciones de zona fija (America/Santiago), independientes de process.env.TZ. Trabajan con dias
// de calendario 'YYYY-MM-DD'. inicioCobroDia es espejo de gomaq_inicio_cobro (migracion 022).
// ---------------------------------------------------------------------------------------------
const formatoSantiago = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

function partesSantiago(instante) {
    const partes = {};
    for (const p of formatoSantiago.formatToParts(new Date(instante))) partes[p.type] = p.value;
    return partes;
}

function diaSantiago(instante) {
    const p = partesSantiago(instante);
    return `${p.year}-${p.month}-${p.day}`;
}

function horaSantiago(instante) {
    return Number(partesSantiago(instante).hour);
}

function aUtc(dia) {
    const [anio, mes, d] = dia.split('-').map(Number);
    return Date.UTC(anio, mes - 1, d);
}

function sumarDias(dia, n) {
    return new Date(aUtc(dia) + n * 86400000).toISOString().slice(0, 10);
}

// dias entre dos dias de calendario, ambos extremos incluidos, con minimo 0
function diasEntre(desde, hasta) {
    return Math.max(0, Math.round((aUtc(hasta) - aUtc(desde)) / 86400000) + 1);
}

// primer dia que se cobra de un despacho: el mismo dia si salio antes de la hora de corte
function inicioCobroDia(fechaDespacho, horaCorte = HORA_CORTE) {
    const dia = diaSantiago(fechaDespacho);
    return horaSantiago(fechaDespacho) >= horaCorte ? sumarDias(dia, 1) : dia;
}

const diaDelMes = (anio, mes, dia) => `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

// dias de corte (el dia de facturacion de cada mes) dentro de [desde, hasta], ambos inclusive
function fechasDeCorte(desde, hasta, diaFacturacion) {
    const cortes = [];
    if (aUtc(desde) > aUtc(hasta)) return cortes;
    let [anio, mes] = desde.split('-').map(Number);
    const [anioFin, mesFin] = hasta.split('-').map(Number);
    while (anio < anioFin || (anio === anioFin && mes <= mesFin)) {
        const corte = diaDelMes(anio, mes, diaFacturacion);
        if (aUtc(corte) >= aUtc(desde) && aUtc(corte) <= aUtc(hasta)) cortes.push(corte);
        mes += 1;
        if (mes > 12) { mes = 1; anio += 1; }
    }
    return cortes;
}

// primer dia de corte estrictamente posterior a `hoy`
function proximoCorte(hoy, diaFacturacion) {
    let [anio, mes] = hoy.split('-').map(Number);
    for (let i = 0; i < 2; i++) {
        const corte = diaDelMes(anio, mes, diaFacturacion);
        if (aUtc(corte) > aUtc(hoy)) return corte;
        mes += 1;
        if (mes > 12) { mes = 1; anio += 1; }
    }
    return null;
}

// Estado de un arriendo en curso (sin recepcion). El dia de corte cierra el periodo (inclusive) y
// el aviso aparece desde ese mismo dia. `ultimoPeriodoHasta` lo conectara el bloque 2b: hasta
// entonces el arriendo se cuenta desde su inicio de cobro.
function resumirArriendoEnCurso({ inicioCobro, ultimoPeriodoHasta = null, hoy, diaFacturacion }) {
    const desde = ultimoPeriodoHasta ? sumarDias(ultimoPeriodoHasta, 1) : inicioCobro;
    const periodos = fechasDeCorte(desde, hoy, diaFacturacion).length;
    return {
        desde,
        dias: diasEntre(desde, hoy),
        periodos_sin_facturar: periodos,
        proximo_corte: proximoCorte(hoy, diaFacturacion),
        aviso: periodos > 0,
    };
}

module.exports = {
    HORA_CORTE, calcularInicioCobro, calcularDiasTranscurridos, diaCalendarioUtc,
    diaSantiago, horaSantiago, sumarDias, diasEntre, inicioCobroDia, fechasDeCorte, proximoCorte, resumirArriendoEnCurso,
};
