// hora (24h) a partir de la cual el dia de despacho ya no cuenta como dia de arriendo
// (entrevista la administrativa: "si se fue a las 10 de la manana se cobra ese dia, si se fue a las 3
// de la tarde no se cobra ese dia" - valor pendiente de confirmar el corte exacto con ella)
const HORA_CORTE = 13;

function calcularInicioCobro(fechaDespacho) {
    const inicio = new Date(fechaDespacho);
    if (inicio.getHours() >= HORA_CORTE) {
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
// (regla de cierre pendiente de confirmar con la administrativa, igual que HORA_CORTE).
// Sin recepcion: hasta hoy inclusive.
function calcularDiasTranscurridos(fechaDespacho, fechaFin) {
    const inicioCobro = calcularInicioCobro(fechaDespacho);
    const fin = fechaFin ? new Date(fechaFin) : new Date();
    const dias = (diaCalendarioUtc(fin) - diaCalendarioUtc(inicioCobro)) / (1000 * 60 * 60 * 24) + 1;
    return Math.max(0, dias);
}

module.exports = { HORA_CORTE, calcularInicioCobro, calcularDiasTranscurridos, diaCalendarioUtc };
