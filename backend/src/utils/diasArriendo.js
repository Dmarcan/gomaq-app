// hora (24h) a partir de la cual el dia de despacho ya no cuenta como dia de arriendo: si salio a las
// 10 de la manana se cobra ese dia, si salio a las 3 de la tarde no (corte exacto pendiente de confirmar).
// Es el valor por defecto: la configuracion vigente vive en la tabla `configuracion`.
const HORA_CORTE = 13;

// proyecta una fecha local a un "dia de calendario" en un marco sin cambios de hora:
// Chile tiene DST (dias de 23/25 horas), asi que restar milisegundos y dividir por 24h
// produce off-by-one dos veces al ano. Date.UTC de los componentes año/mes/dia es el
// patron estandar para aritmetica de dias de calendario.
function diaCalendarioUtc(fecha) {
    return Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
}

// Funciones de zona fija (America/Santiago), independientes de process.env.TZ. Trabajan con dias
// de calendario 'YYYY-MM-DD'. inicioCobroDia es espejo de gomaq_inicio_cobro (migracion 022).
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

// Ultimo dia que se cobra cuando el equipo sale del cliente en el instante `instante` (recepcion, o
// despacho del equipo a otro cliente): el mismo dia si ocurre desde la hora de corte, y el dia
// anterior si ocurre antes. Es la contraparte de inicioCobroDia: con el mismo corte, cada dia se cobra
// a un solo cliente, sin huecos ni solapes (el cliente que recibe el equipo parte en
// inicioCobroDia del mismo instante).
function finCobroDia(instante, horaCorte = HORA_CORTE) {
    const dia = diaSantiago(instante);
    return horaSantiago(instante) >= horaCorte ? dia : sumarDias(dia, -1);
}

const diaDelMes = (anio, mes, dia) => `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

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

module.exports = {
    HORA_CORTE, diaCalendarioUtc,
    diaSantiago, horaSantiago, sumarDias, diasEntre, inicioCobroDia, finCobroDia, proximoCorte,
};
