// Estado de mantencion preventiva de un equipo a partir de su horometro.
// Funciones puras, sin BD: la regla de negocio queda testeable (ver test/mantencion.test.js).
//
// Regla (entrevista el jefe de taller del 21 de julio de 2026): la preventiva toca cada N horas de uso
// (350 h para toda la flota de GOMAQ hoy, configurable por equipo). Lo que se cuenta son las
// horas transcurridas desde la ultima mantencion, no el horometro absoluto: un equipo con
// 1.156 h que recibio mantencion a las 1.100 lleva 56 h de uso, no 1.156.

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

module.exports = { HORAS_AVISO_MANTENCION, calcularEstadoMantencion, requiereAviso };
