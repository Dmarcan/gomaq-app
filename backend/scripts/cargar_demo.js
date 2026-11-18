// Datos de DEMOSTRACION para mostrar el panel: clientes, equipos, arriendos, facturas en todos los estados
// de cobranza, ordenes de trabajo y lecturas de horometro. Todo lleva la marca [DEMO] y se borra con una orden.
//
//   node scripts/cargar_demo.js --simular            # hace la carga en una transaccion y la deshace
//   node scripts/cargar_demo.js                      # carga de verdad
//   node scripts/cargar_demo.js --borrar --simular   # muestra lo que borraria, sin borrar
//   node scripts/cargar_demo.js --borrar             # borra TODO lo de la demo
//
// En Railway la base no tiene acceso publico, asi que se corre dentro del contenedor:
//   railway ssh --service gomaq-app -- node scripts/cargar_demo.js --simular
//
// Fechas: todas relativas al dia de HOY en Santiago (lo da la base al cargar). Los estados de cobranza se
// corren con los dias (una "proxima a vencer" pasa a vencida): cargar el mismo dia de la demo, o borrar y
// volver a cargar.
//
// COMO SE MARCA (sin tabla nueva ni migracion):
//   clientes            nombre '[DEMO] ...', RUT ficticio 99.990.00X (digito verificador valido), sin correo
//                       ni telefono
//   maquinarias         codigo 'DEMO-...' (unico) y descripcion '[DEMO] ...'
//   insumos             nombre '[DEMO] ...'
//   ordenes_trabajo     motivo, diagnostico y observacion '[DEMO] ...', siempre sobre un equipo DEMO
//   movimientos_insumo  descripcion '[DEMO] ...', siempre de una OT DEMO
//   lecturas_horometro  observacion '[DEMO] ...', siempre de un equipo DEMO
//   facturas            folio 'DEMO-0001'... (el folio es texto) y nota de credito 'DEMO-NC-0001'
//   guias, stock_ubicacion: no tienen texto libre; son DEMO por su equipo o insumo DEMO.
//
// DECISIONES DE SEGURIDAD:
//   - No se usa ningun equipo real: registrar un despacho cambia maquinarias.cliente_id y el estado del equipo,
//     y eso seria modificar la flota real. Se crean 4 equipos DEMO propios.
//   - No se usan insumos reales: un consumo moveria su stock. Se crean 2 insumos DEMO con sus existencias en
//     la bodega central (filas propias de stock_ubicacion).
//   - Los ejecutivos (Freddy, Alejandra, Wenceslao, Oscar) se usan si existen; no se crean ni se modifican.
//   - No se crean usuarios ni sesiones. Ninguna OT tiene mecanico: no aparece en la app de un mecanico real.
//   - Sin notificaciones: todo es SQL directo. Los avisos solo los encolan las rutas (ordenes.js, horometro.js,
//     guias.js, facturacion.js, facturas.js, usuarios.js y utils/avisos.js); ningun trigger escribe en
//     notificaciones_pendientes. Ademas los clientes no tienen correo ni telefono y el horometro de cada equipo
//     queda bajo su proxima mantencion (horometro_ultima_mantencion), para que una lectura nueva no avise.
//   - No se escribe en ordenes_eventos (es de solo insercion). Si durante la demo alguien opera una OT DEMO
//     desde el panel y se generan eventos, el borrado los quita por la via de purga (set_config de
//     gomaq.purga, solo en esa transaccion y solo los de OT DEMO).
//   - Facturas sin PDF: archivo_url es NOT NULL, va una ruta inexistente ('demo/sin-documento.pdf'). Abrir el
//     PDF de una factura DEMO desde el panel da error; no se sube nada a Supabase.
//
// BORRADO: toma los clientes, equipos e insumos con la marca y borra, en orden inverso de dependencias, lo
// que cuelga de ellos (facturas, lecturas, lineas, stock, filas hijas de las OT, eventos, OT, guias). Antes
// comprueba que nada de eso toque un equipo real ni un usuario: si un cliente DEMO quedo ligado a un equipo
// real (por ejemplo, un despacho registrado en la demo), o un usuario o solicitud de cuenta apunta a un
// cliente DEMO, NO borra nada y dice que corregir. Clientes y equipos reales nunca se modifican ni se borran.
//
// Todo corre en una transaccion con pg_advisory_xact_lock. La carga es idempotente: si la demo ya esta
// cargada, no inserta nada (0 nuevos); si esta a medias, se detiene y pide --borrar primero.

require('dotenv').config();
const { Client } = require('pg');
const { rutValido } = require('../src/utils/rut');
const { sumarDias, diasEntre } = require('../src/utils/diasArriendo');
const { calcularFacturableOt, calcularTotalFacturable } = require('../src/utils/facturableOt');
const { resolverEjecutivo } = require('../src/utils/cargaClientes');
const { SQL_HOY, estadoCobranza } = require('../src/utils/cobranza');

// numero arbitrario pero fijo del candado de esta carga (migrar.js usa 70214 y cargar_clientes.js 70215)
const CANDADO_CARGA_DEMO = 70216;

const MARCA = '[DEMO]';
const PREFIJO_CODIGO = 'DEMO-';
const PREFIJO_FOLIO = 'DEMO-';
const ARCHIVO_SIN_DOCUMENTO = 'demo/sin-documento.pdf';
const IVA = 0.19;
const ZONA = 'America/Santiago';
const DESCRIPCION_EQUIPO = `${MARCA} Equipo ficticio para la demostracion. Se borra con scripts/cargar_demo.js --borrar`;

// topes de cordura del borrado: la demo crea 6 clientes, 4 equipos y 2 insumos
const TOPE_BORRADO = { clientes: 20, equipos: 20, insumos: 10 };

/** Digito verificador de un RUT (modulo 11). */
function digitoVerificador(cuerpo) {
    const texto = String(cuerpo);
    let suma = 0;
    let factor = 2;
    for (let i = texto.length - 1; i >= 0; i--) {
        suma += Number(texto[i]) * factor;
        factor = factor === 7 ? 2 : factor + 1;
    }
    const resto = 11 - (suma % 11);
    return resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
}

/** RUT con el formato que usa el sistema (sin puntos, con guion): 99990001-X. */
function rutConDigito(cuerpo) {
    return `${cuerpo}-${digitoVerificador(cuerpo)}`;
}

/** Monto total con IVA, en pesos enteros. */
const conIva = (neto) => Math.round(neto * (1 + IVA));

const EQUIPOS = [
    {
        clave: 'E1', codigo: 'DEMO-GH-01', tipo: 'Grúa horquilla', categoria_equipo: 'grua_horquilla', marca: 'Toyota',
        modelo: '8FG25', anio: 2019, capacidad_carga: 2500, altura_trabajo: null, tipo_combustible: 'gas',
        horometro_ultima_mantencion: 1850, tarifa_dia: 26000,
    },
    {
        clave: 'E2', codigo: 'DEMO-GH-02', tipo: 'Grúa horquilla', categoria_equipo: 'grua_horquilla', marca: 'Komatsu',
        modelo: 'FD30', anio: 2020, capacidad_carga: 3000, altura_trabajo: null, tipo_combustible: 'diesel',
        horometro_ultima_mantencion: 3000, tarifa_dia: 29000,
    },
    {
        clave: 'E3', codigo: 'DEMO-PL-01', tipo: 'Plataforma elevadora', categoria_equipo: 'alzahombre', marca: 'Genie',
        modelo: 'GS1932', anio: 2018, capacidad_carga: null, altura_trabajo: 7.6, tipo_combustible: 'electrica',
        horometro_ultima_mantencion: 900, tarifa_dia: 16000,
    },
    {
        clave: 'E4', codigo: 'DEMO-PL-02', tipo: 'Plataforma elevadora', categoria_equipo: 'alzahombre', marca: 'JLG',
        modelo: '1930ES', anio: 2021, capacidad_carga: null, altura_trabajo: 7.8, tipo_combustible: 'electrica',
        horometro_ultima_mantencion: 500, tarifa_dia: 15000,
    },
];

// coordenadas aproximadas en Nuble, Biobio y Maule (para el mapa); C5 queda sin ubicacion y C6 sin actividad
const CLIENTES = [
    { clave: 'C1', nombre: `${MARCA} Constructora Los Aromos SpA`, cuerpoRut: 99990001, giro: 'Construccion de edificios', plazo_pago_dias: 30, ejecutivo: 'Freddy', direccion: 'Direccion ficticia, Chillan', latitud: -36.6123, longitud: -72.0847 },
    { clave: 'C2', nombre: `${MARCA} Agricola Santa Elvira Ltda.`, cuerpoRut: 99990002, giro: 'Cultivo de frutas', plazo_pago_dias: 45, ejecutivo: 'Alejandra', direccion: 'Direccion ficticia, Los Angeles', latitud: -37.4581, longitud: -72.3312 },
    { clave: 'C3', nombre: `${MARCA} Frigorifico del Itata S.A.`, cuerpoRut: 99990003, giro: 'Almacenamiento frigorifico', plazo_pago_dias: 0, ejecutivo: 'Wenceslao', direccion: 'Direccion ficticia, San Carlos', latitud: -36.4302, longitud: -71.9655 },
    { clave: 'C4', nombre: `${MARCA} Bodegas Talca Centro SpA`, cuerpoRut: 99990004, giro: 'Bodegaje y almacenamiento', plazo_pago_dias: 60, ejecutivo: 'Oscar', direccion: 'Direccion ficticia, Talca', latitud: -35.4389, longitud: -71.6201 },
    { clave: 'C5', nombre: `${MARCA} Transportes Rio Nuble Ltda.`, cuerpoRut: 99990005, giro: 'Transporte de carga por carretera', plazo_pago_dias: 30, ejecutivo: 'Freddy', direccion: 'Direccion ficticia, Bulnes', latitud: null, longitud: null },
    { clave: 'C6', nombre: `${MARCA} Comercial Penco Sur SpA`, cuerpoRut: 99990006, giro: 'Venta al por mayor', plazo_pago_dias: 30, ejecutivo: null, direccion: 'Direccion ficticia, Concepcion', latitud: -36.7952, longitud: -73.0127 },
];

const INSUMOS = [
    { clave: 'I1', nombre: `${MARCA} Filtro de aceite motor`, unidad_medida: 'unidad', costo_unitario: 18500, stock: 8 },
    { clave: 'I2', nombre: `${MARCA} Aceite hidraulico ISO 68 bidon 20 L`, unidad_medida: 'bidon', costo_unitario: 64900, stock: 4 },
];

/**
 * Plan completo de la demo para el dia `hoy` ('YYYY-MM-DD', Santiago). Puro: no toca la base, asi se prueba
 * sin Postgres. Las referencias entre filas van por clave (C1, E1, G1...), la carga las traduce a ids.
 */
function planDemo(hoy) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hoy || '')) throw new Error('planDemo necesita hoy como AAAA-MM-DD');
    const d = (n) => sumarDias(hoy, n);
    const plazoDe = Object.fromEntries(CLIENTES.map((c) => [c.clave, c.plazo_pago_dias]));
    const equipoDe = Object.fromEntries(EQUIPOS.map((e) => [e.clave, e]));

    const clientes = CLIENTES.map(({ cuerpoRut, ...c }) => ({ ...c, rut: rutConDigito(cuerpoRut) }));

    // guias: despacho a las 10:00 (antes del corte, se cobra desde ese dia) y recepcion a las 15:00 (despues
    // del corte, ese dia se cobra). inicio_cobro y fin_cobro se guardan explicitos: no dependen de la hora de
    // corte configurada en la base.
    const guias = [
        { clave: 'G1', equipo: 'E1', cliente: 'C1', tipo: 'despacho', dia: d(-330), hora: '10:00' },
        { clave: 'G2', equipo: 'E1', cliente: 'C1', tipo: 'recepcion', dia: d(-215), hora: '15:00' },
        { clave: 'G3', equipo: 'E1', cliente: 'C1', tipo: 'despacho', dia: d(-100), hora: '10:00' },
        { clave: 'G4', equipo: 'E2', cliente: 'C2', tipo: 'despacho', dia: d(-60), hora: '10:00' },
        { clave: 'G5', equipo: 'E3', cliente: 'C3', tipo: 'despacho', dia: d(-250), hora: '10:00' },
        { clave: 'G6', equipo: 'E3', cliente: 'C3', tipo: 'recepcion', dia: d(-160), hora: '15:00' },
        { clave: 'G7', equipo: 'E3', cliente: 'C5', tipo: 'despacho', dia: d(-45), hora: '10:00' },
        { clave: 'G8', equipo: 'E4', cliente: 'C4', tipo: 'despacho', dia: d(-75), hora: '10:00' },
    ];
    // arriendos (despacho y su recepcion, si ya volvio)
    const arriendos = [
        { clave: 'A1', equipo: 'E1', cliente: 'C1', despacho: 'G1', recepcion: 'G2' },
        { clave: 'A5', equipo: 'E1', cliente: 'C1', despacho: 'G3', recepcion: null },
        { clave: 'A2', equipo: 'E2', cliente: 'C2', despacho: 'G4', recepcion: null },
        { clave: 'A3', equipo: 'E3', cliente: 'C3', despacho: 'G5', recepcion: 'G6' },
        { clave: 'A6', equipo: 'E3', cliente: 'C5', despacho: 'G7', recepcion: null },
        { clave: 'A4', equipo: 'E4', cliente: 'C4', despacho: 'G8', recepcion: null },
    ];
    const guiaDe = Object.fromEntries(guias.map((g) => [g.clave, g]));
    for (const a of arriendos) {
        a.inicio = guiaDe[a.despacho].dia;
        a.fin = a.recepcion ? guiaDe[a.recepcion].dia : null;
    }
    const arriendoDe = Object.fromEntries(arriendos.map((a) => [a.clave, a]));

    const equipos = EQUIPOS.map(({ tarifa_dia: _t, ...e }) => ({ ...e, descripcion: DESCRIPCION_EQUIPO }));
    // estado de hoy, coherente con las guias y las OT: E1 en reparacion en la faena de C1; E3 arrendado a C5
    const estadoHoy = {
        E1: { cliente: 'C1', estado: 'en_mantencion', estado_origen: 'ot' },
        E2: { cliente: 'C2', estado: 'operativa', estado_origen: null },
        E3: { cliente: 'C5', estado: 'operativa', estado_origen: null },
        E4: { cliente: 'C4', estado: 'operativa', estado_origen: null },
    };
    for (const e of equipos) Object.assign(e, estadoHoy[e.clave]);

    const insumos = INSUMOS.map((i) => ({ ...i }));

    // ordenes de trabajo: lineas con insumo DEMO o con descripcion libre. El facturable de la OT y la
    // valorizacion salen de utils/facturableOt.js (sin repuestos cobrables no se cobra).
    const linea = (insumo, descripcion, cantidad, precio_unitario, facturable) => ({
        insumo, descripcion: `${MARCA} ${descripcion}`, cantidad, precio_unitario, facturable,
    });
    const ordenes = [
        {
            clave: 'OT1', equipo: 'E1', cliente: 'C1', estado: 'finalizada', tipo_servicio: 'correctivo',
            motivo: `${MARCA} Cadena del mastil con desgaste y perdida de aceite`,
            diagnostico: `${MARCA} Cadena de mastil estirada; se cambia junto con filtro y aceite hidraulico`,
            observacion_final: `${MARCA} Equipo operativo, probado con carga`,
            creada: { dia: d(-290), hora: '09:30' }, llegada: { dia: d(-290), hora: '11:00' }, cierre: { dia: d(-288), hora: '17:00' },
            lineas: [
                linea('I1', 'Filtro de aceite motor', 2, 18500, 'si'),
                linea('I2', 'Aceite hidraulico ISO 68', 1, 64900, 'si'),
                linea(null, 'Cadena de mastil', 1, 148000, 'si'),
            ],
            valorizar: true,
        },
        {
            clave: 'OT2', equipo: 'E1', cliente: 'C1', estado: 'en_reparacion', tipo_servicio: 'correctivo',
            motivo: `${MARCA} Fuga en cilindro de levante`,
            diagnostico: `${MARCA} Sello del cilindro de levante danado`,
            observacion_final: null,
            creada: { dia: d(-3), hora: '08:45' }, llegada: { dia: d(-3), hora: '10:15' }, cierre: null,
            lineas: [
                linea(null, 'Sello de cilindro de levante', 1, 45000, 'pendiente'),
                linea('I2', 'Aceite hidraulico ISO 68', 1, 64900, 'pendiente'),
            ],
            valorizar: false,
        },
        {
            // pendiente de valorizar: terminada, con un repuesto cobrable y sin monto aprobado
            clave: 'OT3', equipo: 'E2', cliente: 'C2', estado: 'finalizada', tipo_servicio: 'reparacion',
            motivo: `${MARCA} Manguera hidraulica rota`,
            diagnostico: `${MARCA} Manguera de alta presion cortada por roce`,
            observacion_final: `${MARCA} Se cambia la manguera; el filtro no se cobra`,
            creada: { dia: d(-14), hora: '09:00' }, llegada: { dia: d(-14), hora: '11:30' }, cierre: { dia: d(-12), hora: '16:00' },
            lineas: [
                linea(null, 'Manguera hidraulica de alta presion', 1, 38000, 'si'),
                linea('I1', 'Filtro de aceite motor', 1, 18500, 'no'),
            ],
            valorizar: false,
        },
        {
            // por facturar: terminada y valorizada, sin factura
            clave: 'OT4', equipo: 'E4', cliente: 'C4', estado: 'finalizada', tipo_servicio: 'bateria_cargador',
            motivo: `${MARCA} El cargador de bateria no carga`,
            diagnostico: `${MARCA} Tarjeta del cargador quemada`,
            observacion_final: `${MARCA} Tarjeta reemplazada, carga normal`,
            creada: { dia: d(-21), hora: '10:00' }, llegada: { dia: d(-21), hora: '12:00' }, cierre: { dia: d(-20), hora: '15:30' },
            lineas: [linea(null, 'Tarjeta de cargador de bateria 24 V', 1, 72000, 'si')],
            valorizar: true,
        },
    ];
    for (const o of ordenes) {
        o.facturable = calcularFacturableOt(o.lineas);
        o.valorizacion = o.valorizar ? calcularTotalFacturable(o.lineas) : null;
    }
    const ordenDe = Object.fromEntries(ordenes.map((o) => [o.clave, o]));

    const lectura = (equipo, cliente, dia, hora, valor, origen, { guia = null, orden = null } = {}) => ({
        equipo, cliente, dia, hora, valor, origen, guia, orden,
        observacion: `${MARCA} Lectura de ${origen === 'guia' ? 'la guia' : origen === 'movil' ? 'terreno' : 'oficina'}`,
    });
    const lecturas = [
        lectura('E1', 'C1', d(-330), '10:00', 1250.0, 'guia', { guia: 'G1' }),
        lectura('E1', 'C1', d(-290), '11:00', 1412.5, 'panel', { orden: 'OT1' }),
        lectura('E1', 'C1', d(-215), '15:00', 1688.0, 'guia', { guia: 'G2' }),
        lectura('E1', 'C1', d(-100), '10:00', 1702.0, 'guia', { guia: 'G3' }),
        lectura('E1', 'C1', d(-30), '12:00', 1905.5, 'panel'),
        lectura('E1', 'C1', d(-3), '10:15', 1986.0, 'movil', { orden: 'OT2' }),
        lectura('E2', 'C2', d(-60), '10:00', 3120.0, 'guia', { guia: 'G4' }),
        lectura('E3', 'C3', d(-250), '10:00', 812.0, 'guia', { guia: 'G5' }),
        lectura('E3', 'C3', d(-160), '15:00', 1090.5, 'guia', { guia: 'G6' }),
        lectura('E3', 'C5', d(-45), '10:00', 1095.0, 'guia', { guia: 'G7' }),
        lectura('E4', 'C4', d(-75), '10:00', 640.0, 'guia', { guia: 'G8' }),
    ];

    // facturas: 12, cubriendo todos los estados de cobranza (utils/cobranza.js)
    let numero = 0;
    const folio = () => `${PREFIJO_FOLIO}${String(++numero).padStart(4, '0')}`;
    const montos = (netoSinTraslado, entrega, retiro) => {
        const traslado = (entrega || 0) + (retiro || 0);
        const neto = netoSinTraslado + traslado;
        return {
            monto_neto: neto, monto: conIva(neto), monto_traslado: traslado,
            traslado_entrega: entrega ?? null, traslado_retiro: retiro ?? null,
        };
    };
    const facturaArriendo = ({ arriendo, desde, hasta, emision, venceEn = 'plazo', pago = null, nc = null, entrega = null, retiro = null, cierra = false }) => {
        const a = arriendoDe[arriendo];
        const dias = diasEntre(desde, hasta);
        const vencimiento = venceEn === null ? null : sumarDias(emision, plazoDe[a.cliente]);
        return {
            folio: folio(), tipo: 'arriendo', arriendo, cliente: a.cliente, equipo: a.equipo, orden: null,
            despacho: a.despacho, recepcion: cierra ? a.recepcion : null,
            periodo_desde: desde, periodo_hasta: hasta, dias,
            ...montos(dias * equipoDe[a.equipo].tarifa_dia, entrega, retiro),
            fecha_emision: emision, fecha_vencimiento: vencimiento, fecha_pago: pago, anulada_nc: nc,
        };
    };
    const facturaReparacion = ({ orden, emision, pago = null }) => {
        const o = ordenDe[orden];
        return {
            folio: folio(), tipo: 'reparacion', arriendo: null, cliente: o.cliente, equipo: null, orden,
            despacho: null, recepcion: null, periodo_desde: null, periodo_hasta: null, dias: null,
            ...montos(o.valorizacion, null, null),
            fecha_emision: emision, fecha_vencimiento: sumarDias(emision, plazoDe[o.cliente]), fecha_pago: pago, anulada_nc: null,
        };
    };
    const facturas = [
        // E1 / C1, primer arriendo (ya devuelto): pagado completo
        facturaArriendo({ arriendo: 'A1', desde: d(-330), hasta: d(-271), emision: d(-270), pago: d(-238), entrega: 70000 }),
        facturaArriendo({ arriendo: 'A1', desde: d(-270), hasta: d(-215), emision: d(-214), pago: d(-181), retiro: 70000, cierra: true }),
        // reparacion de la OT1 (repuestos cobrables), pagada
        facturaReparacion({ orden: 'OT1', emision: d(-285), pago: d(-250) }),
        // E1 / C1, arriendo en curso: dos vencidas (hace 40 y 10 dias) y una al dia
        facturaArriendo({ arriendo: 'A5', desde: d(-100), hasta: d(-71), emision: d(-70), entrega: 80000 }),
        facturaArriendo({ arriendo: 'A5', desde: d(-70), hasta: d(-41), emision: d(-40) }),
        facturaArriendo({ arriendo: 'A5', desde: d(-40), hasta: d(-11), emision: d(-10) }),
        // E2 / C2 (45 dias): una proxima a vencer (en 5 dias, traslado dividido) y una al dia
        facturaArriendo({ arriendo: 'A2', desde: d(-60), hasta: d(-41), emision: d(-40), entrega: 90000, retiro: 90000 }),
        facturaArriendo({ arriendo: 'A2', desde: d(-40), hasta: d(-21), emision: d(-20) }),
        // E4 / C4 (60 dias): proxima a vencer en 2 dias
        facturaArriendo({ arriendo: 'A4', desde: d(-75), hasta: d(-59), emision: d(-58), entrega: 60000 }),
        // E3 / C5 (30 dias): proxima a vencer en 7 dias
        facturaArriendo({ arriendo: 'A6', desde: d(-45), hasta: d(-24), emision: d(-23), entrega: 65000 }),
        // E3 / C3 (contado), arriendo devuelto: una anulada con nota de credito y una sin vencimiento. Quedan
        // dias sin facturar hasta la recepcion: el arriendo aparece en Facturar > Por facturar.
        facturaArriendo({ arriendo: 'A3', desde: d(-250), hasta: d(-191), emision: d(-190), nc: `${PREFIJO_FOLIO}NC-0001`, entrega: 65000 }),
        facturaArriendo({ arriendo: 'A3', desde: d(-190), hasta: d(-171), emision: d(-170), venceEn: null }),
    ];

    return { hoy, clientes, equipos, insumos, guias, arriendos, ordenes, lecturas, facturas };
}

/** Conteo de filas que crea el plan, por tabla. */
function conteoPlan(plan) {
    return {
        clientes: plan.clientes.length,
        maquinarias: plan.equipos.length,
        insumos: plan.insumos.length,
        guias: plan.guias.length,
        ordenes_trabajo: plan.ordenes.length,
        movimientos_insumo: plan.ordenes.reduce((s, o) => s + o.lineas.length, 0),
        lecturas_horometro: plan.lecturas.length,
        facturas: plan.facturas.length,
    };
}

// ----------------------------------------------------------------------------------------------------------
// Consultas de identificacion (las comparten la carga, el borrado y las pruebas)
// ----------------------------------------------------------------------------------------------------------

const SQL_IDS_DEMO = {
    clientes: `SELECT id FROM clientes WHERE starts_with(nombre, '${MARCA}') ORDER BY id`,
    equipos: `SELECT id FROM maquinarias WHERE starts_with(codigo, '${PREFIJO_CODIGO}') ORDER BY id`,
    insumos: `SELECT id FROM insumos WHERE starts_with(nombre, '${MARCA}') ORDER BY id`,
};

async function idsDemo(db) {
    const leer = async (sql) => (await db.query(sql)).rows.map((r) => Number(r.id));
    return {
        clientes: await leer(SQL_IDS_DEMO.clientes),
        equipos: await leer(SQL_IDS_DEMO.equipos),
        insumos: await leer(SQL_IDS_DEMO.insumos),
    };
}

/** Timestamp con zona de Santiago a partir de un dia y una hora local. */
const sqlInstante = (pDia, pHora) => `((${pDia}::date + ${pHora}::time) AT TIME ZONE '${ZONA}')`;
const instante = (x) => (x ? [x.dia, x.hora] : [null, null]);

/**
 * Corre `sql` pasando solo los parametros que nombra, renumerados ($2 y $4 pasan a $1 y $2): Postgres
 * rechaza un parametro que la consulta no usa. Las listas de conflictos y de borrados comparten parametros.
 */
function consultar(db, sql, params) {
    const usados = [...new Set(sql.match(/\$\d+/g) || [])].map((m) => Number(m.slice(1))).sort((a, b) => a - b);
    const texto = usados.reduce((s, n, i) => s.replace(new RegExp(`\\$${n}(?!\\d)`, 'g'), () => `$${i + 1}`), sql);
    return db.query(texto, usados.map((n) => params[n - 1]));
}

// ----------------------------------------------------------------------------------------------------------
// Carga
// ----------------------------------------------------------------------------------------------------------

/**
 * Carga la demo con un Client de pg ya conectado. Con simular = true deshace todo al final; con un error
 * tambien (y lo relanza). Devuelve el resumen con los conteos.
 */
async function cargarDemo(db, { simular = false } = {}) {
    const resumen = { modo: 'cargar', simular, nuevos: {}, yaCargada: false, hoy: null, avisos: [], plan: null };
    await db.query('BEGIN');
    try {
        await db.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_CARGA_DEMO]);
        const hoy = (await db.query(`SELECT to_char(${SQL_HOY}, 'YYYY-MM-DD') AS hoy`)).rows[0].hoy;
        resumen.hoy = hoy;
        const plan = planDemo(hoy);
        resumen.plan = plan;

        // idempotencia: todo o nada
        const existentes = await idsDemo(db);
        const total = existentes.clientes.length + existentes.equipos.length + existentes.insumos.length;
        const esperado = plan.clientes.length + plan.equipos.length + plan.insumos.length;
        if (total > 0) {
            const completa = existentes.clientes.length === plan.clientes.length
                && existentes.equipos.length === plan.equipos.length
                && existentes.insumos.length === plan.insumos.length;
            if (!completa) {
                throw new Error(
                    `La demo esta a medias (${existentes.clientes.length} clientes, ${existentes.equipos.length} equipos y `
                    + `${existentes.insumos.length} insumos con la marca; se esperaban ${esperado} filas). `
                    + 'Corre primero --borrar y vuelve a cargar. No se inserto nada.'
                );
            }
            resumen.yaCargada = true;
            for (const k of Object.keys(conteoPlan(plan))) resumen.nuevos[k] = 0;
            await db.query('ROLLBACK');
            return resumen;
        }

        // ningun cliente real con un RUT de la demo, ni un equipo con un codigo de la demo
        const ruts = plan.clientes.map((c) => c.rut.replace('-', ''));
        const choqueRut = await db.query(
            `SELECT id, nombre FROM clientes WHERE rut IS NOT NULL
               AND upper(regexp_replace(rut, '[^0-9kK]', '', 'g')) = ANY($1::text[])`,
            [ruts]
        );
        if (choqueRut.rows.length) {
            throw new Error(`Ya hay clientes con un RUT de la demo (ids ${choqueRut.rows.map((r) => r.id).join(', ')}): no se inserto nada.`);
        }

        // ejecutivos: se usan los que existen; no se crean
        const ejecutivos = (await db.query('SELECT id, nombre FROM ejecutivos ORDER BY id')).rows;
        const idEjecutivo = {};
        for (const nombre of new Set(plan.clientes.map((c) => c.ejecutivo).filter(Boolean))) {
            const r = resolverEjecutivo(nombre, ejecutivos);
            idEjecutivo[nombre] = r.estado === 'uno' ? r.id : null;
            if (r.estado !== 'uno') resumen.avisos.push(`Ejecutivo "${nombre}" ${r.estado === 'ambiguo' ? 'ambiguo' : 'no existe'}: sus clientes DEMO quedan sin ejecutivo.`);
        }

        const id = {};
        const nuevos = {};
        const sumar = (tabla) => { nuevos[tabla] = (nuevos[tabla] || 0) + 1; };

        for (const c of plan.clientes) {
            const r = await db.query(
                `INSERT INTO clientes (nombre, rut, email, telefono, direccion, giro, plazo_pago_dias, ejecutivo_id, latitud, longitud, created_at)
                 VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, ${sqlInstante('$9', "'09:00'")})
                 RETURNING id`,
                [c.nombre, c.rut, c.direccion, c.giro, c.plazo_pago_dias, c.ejecutivo ? idEjecutivo[c.ejecutivo] : null,
                 c.latitud, c.longitud, sumarDias(hoy, -340)]
            );
            id[c.clave] = r.rows[0].id;
            sumar('clientes');
        }

        for (const e of plan.equipos) {
            const r = await db.query(
                `INSERT INTO maquinarias (codigo, tipo, categoria_equipo, marca, modelo, anio, capacidad_carga, altura_trabajo,
                                          tipo_combustible, descripcion, cliente_id, estado, estado_origen,
                                          horometro_ultima_mantencion, alerta_mantencion_enviada)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false)
                 RETURNING id`,
                [e.codigo, e.tipo, e.categoria_equipo, e.marca, e.modelo, e.anio, e.capacidad_carga, e.altura_trabajo,
                 e.tipo_combustible, e.descripcion, e.cliente ? id[e.cliente] : null, e.estado, e.estado_origen,
                 e.horometro_ultima_mantencion]
            );
            id[e.clave] = r.rows[0].id;
            sumar('maquinarias');
        }

        // insumos DEMO con sus existencias en la bodega central (si existe)
        const bodega = (await db.query("SELECT id FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1")).rows[0];
        for (const i of plan.insumos) {
            const r = await db.query(
                `INSERT INTO insumos (nombre, unidad_medida, costo_unitario, stock_actual)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [i.nombre, i.unidad_medida, i.costo_unitario, bodega ? i.stock : 0]
            );
            id[i.clave] = r.rows[0].id;
            sumar('insumos');
            if (bodega) {
                await db.query('INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, $3)', [bodega.id, r.rows[0].id, i.stock]);
                sumar('stock_ubicacion');
            }
        }
        if (!bodega) resumen.avisos.push('No hay bodega en ubicaciones_stock: los insumos DEMO quedan con stock 0.');

        for (const g of plan.guias) {
            const r = await db.query(
                `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id, inicio_cobro, fin_cobro, created_at)
                 VALUES ($1, $2, NULL, ${sqlInstante('$3', '$4')}, false, $5, $6, $7, ${sqlInstante('$3', '$4')})
                 RETURNING id`,
                [id[g.equipo], g.tipo, g.dia, g.hora, id[g.cliente],
                 g.tipo === 'despacho' ? g.dia : null, g.tipo === 'recepcion' ? g.dia : null]
            );
            id[g.clave] = r.rows[0].id;
            sumar('guias');
        }

        for (const o of plan.ordenes) {
            const [cDia, cHora] = instante(o.creada);
            const [lDia, lHora] = instante(o.llegada);
            const [fDia, fHora] = instante(o.cierre);
            const r = await db.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, origen, motivo, diagnostico, estado,
                                              facturable, valorizacion, tipo_servicio, observacion_final,
                                              fecha_creacion, llegada_at, fecha_cierre)
                 VALUES ($1, $2, NULL, 'directo', $3, $4, $5, $6, $7, $8, $9,
                         ${sqlInstante('$10', '$11')},
                         CASE WHEN $12::date IS NULL THEN NULL ELSE ${sqlInstante('$12', '$13')} END,
                         CASE WHEN $14::date IS NULL THEN NULL ELSE ${sqlInstante('$14', '$15')} END)
                 RETURNING id`,
                [id[o.equipo], id[o.cliente], o.motivo, o.diagnostico, o.estado, o.facturable, o.valorizacion,
                 o.tipo_servicio, o.observacion_final, cDia, cHora, lDia, lHora, fDia, fHora]
            );
            id[o.clave] = r.rows[0].id;
            sumar('ordenes_trabajo');
            // las lineas se registran al llegar a terreno (o al crear la OT si no hay llegada)
            const [mDia, mHora] = o.llegada ? [lDia, lHora] : [cDia, cHora];
            for (const l of o.lineas) {
                await db.query(
                    `INSERT INTO movimientos_insumo (insumo_id, orden_trabajo_id, cantidad, tipo, usuario_id, facturable,
                                                     descripcion, precio_unitario, created_at)
                     VALUES ($1, $2, $3, 'salida', NULL, $4, $5, $6, ${sqlInstante('$7', '$8')})`,
                    [l.insumo ? id[l.insumo] : null, id[o.clave], l.cantidad, l.facturable, l.descripcion, l.precio_unitario, mDia, mHora]
                );
                sumar('movimientos_insumo');
            }
        }

        for (const l of plan.lecturas) {
            await db.query(
                `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, cliente_id, orden_trabajo_id, guia_id,
                                                 usuario_id, observacion, fecha, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, ${sqlInstante('$8', '$9')}, ${sqlInstante('$8', '$9')})`,
                [id[l.equipo], l.valor, l.origen, id[l.cliente], l.orden ? id[l.orden] : null, l.guia ? id[l.guia] : null,
                 l.observacion, l.dia, l.hora]
            );
            sumar('lecturas_horometro');
        }

        // facturas: created_at = dia de emision a mediodia (la rentabilidad filtra por created_at)
        for (const f of plan.facturas) {
            await db.query(
                `INSERT INTO facturas (orden_trabajo_id, maquinaria_id, guia_despacho_id, guia_recepcion_id, cliente_id,
                                       periodo_desde, periodo_hasta, folio, archivo_url, monto, monto_neto, monto_traslado,
                                       traslado_entrega, traslado_retiro, fecha_emision, fecha_vencimiento, fecha_pago,
                                       anulada_nc, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                         ${sqlInstante('$15', "'12:00'")})`,
                [f.orden ? id[f.orden] : null, f.equipo ? id[f.equipo] : null, f.despacho ? id[f.despacho] : null,
                 f.recepcion ? id[f.recepcion] : null, id[f.cliente], f.periodo_desde, f.periodo_hasta, f.folio,
                 ARCHIVO_SIN_DOCUMENTO, f.monto, f.monto_neto, f.monto_traslado, f.traslado_entrega, f.traslado_retiro,
                 f.fecha_emision, f.fecha_vencimiento, f.fecha_pago, f.anulada_nc]
            );
            sumar('facturas');
        }

        resumen.nuevos = nuevos;
        resumen.ids = id;
        await db.query(simular ? 'ROLLBACK' : 'COMMIT');
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    }
    return resumen;
}

// ----------------------------------------------------------------------------------------------------------
// Borrado
// ----------------------------------------------------------------------------------------------------------

// Filas que impiden borrar sin tocar algo real. $1 clientes DEMO, $2 equipos DEMO, $3 insumos DEMO.
const CONFLICTOS = [
    {
        que: 'equipos reales asignados hoy a un cliente DEMO (maquinarias.cliente_id)',
        sql: 'SELECT id, codigo AS detalle FROM maquinarias WHERE cliente_id = ANY($1) AND NOT (id = ANY($2))',
    },
    {
        que: 'guias de equipos reales con un cliente DEMO',
        sql: 'SELECT id, maquinaria_id::text AS detalle FROM guias WHERE cliente_id = ANY($1) AND NOT (maquinaria_id = ANY($2))',
    },
    {
        que: 'ordenes de trabajo de equipos reales con un cliente DEMO',
        sql: 'SELECT id, maquinaria_id::text AS detalle FROM ordenes_trabajo WHERE cliente_id = ANY($1) AND NOT (maquinaria_id = ANY($2))',
    },
    {
        que: 'facturas de un cliente DEMO sobre un equipo real',
        sql: `SELECT f.id, f.folio AS detalle FROM facturas f LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
              WHERE COALESCE(f.cliente_id, ot.cliente_id) = ANY($1)
                AND COALESCE(f.maquinaria_id, ot.maquinaria_id) IS NOT NULL
                AND NOT (COALESCE(f.maquinaria_id, ot.maquinaria_id) = ANY($2))`,
    },
    {
        que: 'lecturas de horometro de equipos reales con un cliente DEMO',
        sql: 'SELECT id, maquinaria_id::text AS detalle FROM lecturas_horometro WHERE cliente_id = ANY($1) AND NOT (maquinaria_id = ANY($2))',
    },
    {
        que: 'solicitudes de un cliente DEMO sobre equipos reales',
        sql: `SELECT id, maquinaria_id::text AS detalle FROM solicitudes
              WHERE cliente_id = ANY($1) AND maquinaria_id IS NOT NULL AND NOT (maquinaria_id = ANY($2))`,
    },
    {
        que: 'usuarios (cuentas del portal) de un cliente DEMO',
        sql: 'SELECT id, email AS detalle FROM usuarios WHERE cliente_id = ANY($1)',
    },
    {
        que: 'solicitudes de cuenta ligadas a un cliente DEMO',
        sql: 'SELECT id, email AS detalle FROM solicitudes_cliente WHERE cliente_id = ANY($1)',
    },
    {
        que: 'consumos de un insumo DEMO en ordenes de equipos reales',
        sql: `SELECT mi.id, mi.orden_trabajo_id::text AS detalle FROM movimientos_insumo mi
              JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
              WHERE mi.insumo_id = ANY($3) AND NOT (ot.maquinaria_id = ANY($2))`,
    },
];

// Borrado en orden inverso de dependencias. $1 clientes, $2 equipos, $3 insumos, $4 OT DEMO, $5 guias DEMO.
const BORRADOS = [
    ['facturas', `DELETE FROM facturas WHERE maquinaria_id = ANY($2) OR orden_trabajo_id = ANY($4)
                     OR guia_despacho_id = ANY($5) OR guia_recepcion_id = ANY($5) OR cliente_id = ANY($1)`],
    ['lecturas_horometro', `DELETE FROM lecturas_horometro WHERE maquinaria_id = ANY($2) OR orden_trabajo_id = ANY($4)
                     OR guia_id = ANY($5) OR cliente_id = ANY($1)`],
    ['movimientos_insumo', 'DELETE FROM movimientos_insumo WHERE orden_trabajo_id = ANY($4) OR insumo_id = ANY($3)'],
    ['stock_ubicacion', 'DELETE FROM stock_ubicacion WHERE insumo_id = ANY($3)'],
    ['evidencias_fotograficas', 'DELETE FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($4)'],
    ['firmas_recepcion', 'DELETE FROM firmas_recepcion WHERE orden_trabajo_id = ANY($4)'],
    ['ot_servicios', 'DELETE FROM ot_servicios WHERE orden_trabajo_id = ANY($4)'],
    ['tramos_trabajo', 'DELETE FROM tramos_trabajo WHERE orden_trabajo_id = ANY($4)'],
    ['posiciones_mecanico', 'DELETE FROM posiciones_mecanico WHERE orden_trabajo_id = ANY($4)'],
    ['solicitudes', 'DELETE FROM solicitudes WHERE orden_trabajo_id = ANY($4) OR maquinaria_id = ANY($2) OR cliente_id = ANY($1)'],
    ['ordenes_eventos', 'DELETE FROM ordenes_eventos WHERE orden_trabajo_id = ANY($4)'],
    ['ordenes_trabajo', 'DELETE FROM ordenes_trabajo WHERE id = ANY($4)'],
    ['guias', 'DELETE FROM guias WHERE id = ANY($5)'],
    ['maquinarias', 'DELETE FROM maquinarias WHERE id = ANY($2)'],
    ['insumos', 'DELETE FROM insumos WHERE id = ANY($3)'],
    ['clientes', 'DELETE FROM clientes WHERE id = ANY($1)'],
];

/**
 * Borra todo lo de la demo con un Client de pg ya conectado. Con simular = true deshace todo al final.
 * Si encuentra algo real ligado a la demo, no borra nada y lanza un error con la lista (codigo 'conflicto').
 */
async function borrarDemo(db, { simular = false } = {}) {
    const resumen = { modo: 'borrar', simular, borrados: {}, avisos: [] };
    await db.query('BEGIN');
    try {
        await db.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_CARGA_DEMO]);
        const ids = await idsDemo(db);
        for (const [k, tope] of Object.entries(TOPE_BORRADO)) {
            if (ids[k].length > tope) {
                throw new Error(`Hay ${ids[k].length} ${k} con la marca de la demo (tope ${tope}): algo no cuadra, no se borro nada.`);
            }
        }
        const p123 = [ids.clientes, ids.equipos, ids.insumos];

        const conflictos = [];
        for (const c of CONFLICTOS) {
            const r = await consultar(db, c.sql, p123);
            if (r.rows.length) conflictos.push(`${c.que}: ${r.rows.slice(0, 10).map((x) => `id ${x.id} (${x.detalle})`).join(', ')}`);
        }
        if (conflictos.length) {
            const e = new Error(
                'Hay datos reales ligados a la demo; no se borro nada. Corrigelos desde el panel y vuelve a intentar:\n- '
                + conflictos.join('\n- ')
            );
            e.codigo = 'conflicto';
            throw e;
        }

        const ordenes = (await db.query('SELECT id FROM ordenes_trabajo WHERE maquinaria_id = ANY($1)', [ids.equipos])).rows.map((r) => r.id);
        const guias = (await db.query('SELECT id FROM guias WHERE maquinaria_id = ANY($1)', [ids.equipos])).rows.map((r) => r.id);
        const params = [...p123, ordenes, guias];

        // aviso: filas de clientes reales que cuelgan de un equipo DEMO (se crearon en la demo; se borran)
        const ajenas = await db.query(
            `SELECT (SELECT COUNT(*)::int FROM guias WHERE id = ANY($2) AND cliente_id IS NOT NULL AND NOT (cliente_id = ANY($1)))
                  + (SELECT COUNT(*)::int FROM ordenes_trabajo WHERE id = ANY($3) AND cliente_id IS NOT NULL AND NOT (cliente_id = ANY($1)))
                  AS n`,
            [ids.clientes, guias, ordenes]
        );
        if (ajenas.rows[0].n > 0) {
            resumen.avisos.push(`${ajenas.rows[0].n} guia(s) u orden(es) de un equipo DEMO tenian un cliente real; se borran con el equipo (el cliente no se toca).`);
        }

        // ordenes_eventos es de solo insercion: la via de purga solo si hay eventos de OT DEMO, y solo en esta transaccion
        const eventos = (await db.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [ordenes])).rows[0].n;
        if (eventos > 0) await db.query("SELECT set_config('gomaq.purga', 'on', true)");

        for (const [tabla, sql] of BORRADOS) {
            // cada DELETE usa solo los parametros que nombra (pg rechaza parametros de sobra)
            const usados = [...new Set(sql.match(/\$\d/g))].map((m) => Number(m.slice(1))).sort();
            const texto = usados.reduce((s, n, i) => s.split(`$${n}`).join(`$${i + 1}`), sql);
            const r = await db.query(texto, usados.map((n) => params[n - 1]));
            resumen.borrados[tabla] = r.rowCount;
        }

        const quedan = await idsDemo(db);
        if (quedan.clientes.length || quedan.equipos.length || quedan.insumos.length) {
            throw new Error('Despues de borrar todavia quedan filas con la marca: no se borro nada.');
        }
        await db.query(simular ? 'ROLLBACK' : 'COMMIT');
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    }
    return resumen;
}

// ----------------------------------------------------------------------------------------------------------
// Salida
// ----------------------------------------------------------------------------------------------------------

const pesos = (n) => (n === null || n === undefined ? '-' : `$${Number(n).toLocaleString('es-CL')}`);

function imprimirPlan(plan) {
    const nombre = Object.fromEntries(plan.clientes.map((c) => [c.clave, c.nombre]));
    const codigo = Object.fromEntries(plan.equipos.map((e) => [e.clave, e.codigo]));
    console.log(`Hoy (Santiago): ${plan.hoy}`);
    console.log('Clientes:');
    for (const c of plan.clientes) {
        console.log(`  ${c.nombre} | RUT ${c.rut} | plazo ${c.plazo_pago_dias} dias | ejecutivo ${c.ejecutivo || '-'} | ${c.latitud === null ? 'sin ubicacion' : `${c.latitud}, ${c.longitud}`}`);
    }
    console.log('Equipos:');
    for (const e of plan.equipos) console.log(`  ${e.codigo} ${e.marca} ${e.modelo} | ${e.estado} | cliente ${e.cliente ? nombre[e.cliente] : '-'}`);
    console.log('Arriendos:');
    for (const a of plan.arriendos) console.log(`  ${codigo[a.equipo]} -> ${nombre[a.cliente]}: desde ${a.inicio}${a.fin ? ` hasta ${a.fin} (devuelto)` : ' (en curso)'}`);
    console.log('Ordenes de trabajo:');
    for (const o of plan.ordenes) console.log(`  ${codigo[o.equipo]} ${o.estado} | facturable ${o.facturable ? 'si' : 'no'} | valorizacion ${pesos(o.valorizacion)} | ${o.motivo}`);
    console.log('Facturas:');
    for (const f of plan.facturas) {
        console.log(`  ${f.folio} ${f.tipo} | ${nombre[f.cliente]} | neto ${pesos(f.monto_neto)} total ${pesos(f.monto)} traslado ${pesos(f.monto_traslado)}`
            + ` | emision ${f.fecha_emision} vence ${f.fecha_vencimiento || '-'} | ${estadoCobranza(f, plan.hoy)}`);
    }
}

function imprimir(r) {
    if (r.modo === 'cargar') {
        if (r.plan && r.simular && !r.yaCargada) imprimirPlan(r.plan);
        if (r.yaCargada) console.log('La demo ya estaba cargada: 0 nuevos. Para recargarla con las fechas de hoy, corre primero --borrar.');
        const partes = Object.entries(r.nuevos).map(([t, n]) => `${t} ${n}`);
        console.log(`Nuevos: ${partes.join(', ') || 'ninguno'}`);
    } else {
        const partes = Object.entries(r.borrados).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`);
        console.log(`${r.simular ? 'Se borrarian' : 'Borrados'}: ${partes.join(', ') || 'nada (no habia demo)'}`);
    }
    for (const a of r.avisos) console.log(`Aviso: ${a}`);
    if (r.simular) console.log('Simulacion: no se guardo nada.');
    else console.log(r.yaCargada ? 'No se guardo nada.' : 'Guardado.');
}

async function main() {
    const argv = process.argv.slice(2);
    const simular = argv.includes('--simular');
    const borrar = argv.includes('--borrar');
    const desconocidos = argv.filter((a) => !['--simular', '--borrar'].includes(a));
    if (desconocidos.length) throw new Error(`Opciones desconocidas: ${desconocidos.join(' ')} (validas: --simular, --borrar)`);
    if (!(process.env.DATABASE_URL_MIGRACION || process.env.DATABASE_URL)) throw new Error('Falta DATABASE_URL');

    const db = new Client({ connectionString: (process.env.DATABASE_URL_MIGRACION || process.env.DATABASE_URL) });
    await db.connect();
    try {
        imprimir(borrar ? await borrarDemo(db, { simular }) : await cargarDemo(db, { simular }));
    } finally {
        await db.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = {
    CANDADO_CARGA_DEMO, MARCA, PREFIJO_CODIGO, PREFIJO_FOLIO, SQL_IDS_DEMO,
    digitoVerificador, rutConDigito, conIva, planDemo, conteoPlan, idsDemo, consultar, cargarDemo, borrarDemo,
};
