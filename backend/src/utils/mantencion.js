// Estado de mantencion preventiva de un equipo a partir de su horometro.
// Funciones puras, sin BD: la regla de negocio queda testeable (ver test/mantencion.test.js).
//
// Regla: la preventiva toca cada N horas de uso
// (350 h para toda la flota de GOMAQ hoy, configurable por equipo). Lo que se cuenta son las
// horas transcurridas desde la ultima mantencion, no el horometro absoluto: un equipo con
// 1.156 h que recibio mantencion a las 1.100 lleva 56 h de uso, no 1.156.

const { num } = require('./valores');

/** Horas de margen con las que se avisa antes de cumplir el intervalo. */
const HORAS_AVISO_MANTENCION = 50;

/**
 * @param {object} datos
 * @param {number|null} datos.ultimaLectura        horometro mas reciente del equipo
 * @param {number|null} datos.horometroUltimaMantencion  base del ciclo actual (null = desde 0)
 * @param {number} datos.intervaloHoras            intervalo del equipo (default 350)
 */
function calcularEstadoMantencion({ ultimaLectura, horometroUltimaMantencion, intervaloHoras }) {
    const intervalo = Number(intervaloHoras) || 0;
    if (ultimaLectura === null || ultimaLectura === undefined || intervalo <= 0) {
        return {
            horas_usadas: null,
            horas_restantes: null,
            proxima_mantencion_en: null,
            por_vencer: false,
            vencida: false,
        };
    }

    const base = Number(horometroUltimaMantencion) || 0;
    // una lectura menor a la base solo puede venir de un horometro reemplazado o de un dato
    // mal ingresado; se acota a 0 en vez de devolver horas negativas
    const horasUsadas = Math.max(0, Number(ultimaLectura) - base);
    const horasRestantes = intervalo - horasUsadas;

    return {
        horas_usadas: horasUsadas,
        horas_restantes: horasRestantes,
        proxima_mantencion_en: base + intervalo,
        por_vencer: horasRestantes <= HORAS_AVISO_MANTENCION && horasRestantes > 0,
        vencida: horasRestantes <= 0,
    };
}

/**
 * Si corresponde avisar. Se avisa tanto por vencer como ya vencida: un equipo que paso el
 * intervalo sin que nadie registrara lectura tiene que alertar igual, no quedarse callado.
 */
function requiereAviso(estado) {
    return estado.por_vencer || estado.vencida;
}


/**
 * Equipos que ya cumplieron el intervalo de mantencion o estan por cumplirlo, del mas urgente al
 * menos (las vencidas, con horas restantes negativas, primero). Una sola definicion para
 * GET /api/horometro/alertas y para el contador del dashboard.
 */
async function cargarAlertasMantencion(db) {
    const result = await db.query(
        `SELECT m.id, m.codigo, m.tipo, m.intervalo_mantencion_horas, m.horometro_ultima_mantencion,
                c.nombre AS cliente_nombre, u.valor AS ultima_lectura, u.fecha AS ultima_fecha
         FROM maquinarias m
         LEFT JOIN clientes c ON c.id = m.cliente_id
         JOIN LATERAL (
             SELECT valor, fecha FROM lecturas_horometro l
             WHERE l.maquinaria_id = m.id ORDER BY l.fecha DESC LIMIT 1
         ) u ON true
         WHERE m.estado <> 'fuera_de_servicio'`
    );
    return result.rows
        .map((fila) => {
            const estado = calcularEstadoMantencion({
                ultimaLectura: num(fila.ultima_lectura),
                horometroUltimaMantencion: num(fila.horometro_ultima_mantencion),
                intervaloHoras: num(fila.intervalo_mantencion_horas),
            });
            return {
                id: fila.id,
                codigo: fila.codigo,
                tipo: fila.tipo,
                cliente_nombre: fila.cliente_nombre,
                ultima_lectura: num(fila.ultima_lectura),
                ultima_fecha: fila.ultima_fecha,
                intervalo_mantencion_horas: num(fila.intervalo_mantencion_horas),
                ...estado,
            };
        })
        .filter((e) => requiereAviso(e))
        .sort((a, b) => a.horas_restantes - b.horas_restantes);
}

/** Cuantas alertas hay vencidas y cuantas por vencer (las que cuenta el dashboard). */
function contarAlertas(equipos) {
    return {
        vencidas: equipos.filter((e) => e.vencida).length,
        proximas: equipos.filter((e) => e.por_vencer && !e.vencida).length,
    };
}

module.exports = { HORAS_AVISO_MANTENCION, calcularEstadoMantencion, requiereAviso, cargarAlertasMantencion, contarAlertas };
