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

function calcularDiasTranscurridos(fechaDespacho, fechaFin) {
    const inicioCobro = calcularInicioCobro(fechaDespacho);
    const fin = fechaFin ? new Date(fechaFin) : new Date();
    return Math.max(0, Math.round((fin - inicioCobro) / (1000 * 60 * 60 * 24)));
}

module.exports = { HORA_CORTE, calcularInicioCobro, calcularDiasTranscurridos };
